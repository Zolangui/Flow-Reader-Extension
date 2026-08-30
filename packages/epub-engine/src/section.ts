import EpubCFI from "./epubcfi";
import Hook from "./utils/hook";
import { sprint, isKnownRequestType, mediaTypeToRequestType } from "./utils/core";
import Path from "./utils/path";
import { replaceBase } from "./utils/replacements";
import Request from "./utils/request";
import type { SpineItem, GlobalLayout, SearchResult, RequestFunction } from "./types";

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (!signal?.aborted) return;

	if (signal.reason) {
		throw signal.reason;
	}

	const error = new Error("The operation was aborted");
	error.name = "AbortError";
	throw error;
}

/**
 * Request implementations backed by JSZip or an application cache may accept
 * an AbortSignal without actually interrupting their work. Race their result
 * so callers can release a cancelled canonical/measurement job immediately;
 * the attached handlers also consume a later request rejection safely.
 */
function abortableRequest<T>(promise: PromiseLike<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return Promise.resolve(promise);
	throwIfAborted(signal);

	return new Promise<T>((resolve, reject) => {
		const onAbort = (): void => {
			cleanup();
			try {
				throwIfAborted(signal);
			} catch (error) {
				reject(error);
			}
		};
		const cleanup = (): void => signal.removeEventListener("abort", onAbort);

		signal.addEventListener("abort", onAbort, { once: true });
		Promise.resolve(promise).then(
			(value) => {
				cleanup();
				resolve(value);
			},
			(error: unknown) => {
				cleanup();
				reject(error);
			}
		);
	});
}

/**
 * Copy a hook's callback list without sharing its mutable Hook instance.
 *
 * Detached measurement sections must run the same source transformation
 * callbacks as their live counterpart (base URL, resource substitutions,
 * etc.), but their destruction must never clear the live Spine hook list.
 */
function cloneHook(hook: Hook, sourceSection: Section, cloneSection: Section): Hook {
	// Standalone Sections create their hooks with themselves as the callback
	// context; a bare Hook uses itself. Preserve an external Spine/Rendition
	// context, but never let a non-arrow callback invoked by a measurement clone
	// mutate the live Section or Hook.
	const cloned = hook.context === hook
		? new Hook()
		: new Hook(hook.context === sourceSection ? cloneSection : hook.context);
	cloned.register([...hook.list()]);
	return cloned;
}

/**
 * Represents a Section of the Book
 *
 * In most books this is equivalent to a Chapter
 * @param {object} item  The spine item representing the section
 * @param {object} hooks hooks for serialize and content
 */
class Section {
	idref: string | undefined;
	linear: boolean | undefined;
	properties: string[] | undefined;
	index: number | undefined;
	href: string | undefined;
	url: string | undefined;
	canonical: string;
	next: (() => Section | undefined) | undefined;
	prev: (() => Section | undefined) | undefined;
	cfiBase: string | undefined;
	hooks: { serialize: Hook; content: Hook } | undefined;
	document: Document | undefined;
	contents: Element | undefined;
	output: string | undefined;
	request!: RequestFunction;
	mediaType: string | undefined;

	constructor(item: SpineItem, hooks?: { serialize: Hook; content: Hook }){
		this.idref = item.idref;
		this.linear = item.linear === "yes";
		this.properties = item.properties;
		this.index = item.index;
		this.href = item.href;
		this.url = item.url;
		this.canonical = item.canonical;
		this.mediaType = item.mediaType;
		this.next = item.next;
		this.prev = item.prev;

		this.cfiBase = item.cfiBase;

		if (hooks) {
			this.hooks = hooks;
		} else {
			this.hooks = {} as { serialize: Hook; content: Hook };
			this.hooks!.serialize = new Hook(this);
			this.hooks!.content = new Hook(this);
		}

		this.document = undefined;
		this.contents = undefined;
		this.output = undefined;
	}

	/**
	 * Create a detached, presentation-safe copy of this spine occurrence.
	 *
	 * Rendering a live Section in a second manager is unsafe: `load()` caches
	 * its document and `IframeView.unload()` calls `section.unload()`, which
	 * could release the document currently used by the visible rendition. The
	 * clone owns its DOM, output and Hook instances, while preserving a snapshot
	 * of the source transformation callbacks registered at clone time.
	 *
	 * Navigation links are intentionally removed. A layout measurer renders one
	 * occurrence at a time; following `next`/`prev` would re-enter live Spine
	 * Sections and break isolation.
	 */
	cloneForMeasurement(): Section {
		if (!this.hooks ||
			this.idref === undefined ||
			this.linear === undefined ||
			this.properties === undefined ||
			this.index === undefined ||
			this.href === undefined ||
			this.url === undefined ||
			this.canonical === undefined ||
			this.cfiBase === undefined) {
			throw new Error("Cannot clone a destroyed section for measurement");
		}

		const item: SpineItem = {
			idref: this.idref,
			linear: this.linear ? "yes" : "no",
			properties: [...this.properties],
			index: this.index,
			href: this.href,
			url: this.url,
			canonical: this.canonical,
			cfiBase: this.cfiBase,
			...(this.mediaType ? { mediaType: this.mediaType } : {}),
			next: () => undefined,
			prev: () => undefined
		};

		const clone = new Section(item);
		clone.hooks = {
			serialize: cloneHook(this.hooks.serialize, this, clone),
			content: cloneHook(this.hooks.content, this, clone)
		};
		// Some integrators provide a per-section requester rather than passing
		// one to render(). Preserve it without coupling document state.
		clone.request = this.request;
		return clone;
	}

	private async requestSource(_request?: RequestFunction, signal?: AbortSignal): Promise<Document> {
		const request = _request || this.request || Request;
		throwIfAborted(signal);

		// A recognized filename extension wins (preserves lenient html vs strict
		// xhtml parsing); the manifest media-type only fills in when the
		// extension is missing or unknown (e.g. an extensionless split resource).
		// Exception: an xhtml-declared document named .htm/.html is parsed
		// strictly, since HTML has no self-closing syntax and would swallow the
		// document at a tag like <title/>. handleResponse falls back to the
		// lenient parser when the strict parse fails, so a book that genuinely
		// needs lenient parsing still gets it.
		const ext = new Path(this.url!).extension;
		const declaredType = mediaTypeToRequestType(this.mediaType);
		const type = declaredType === "xhtml" && (ext === "html" || ext === "htm")
			? declaredType
			: isKnownRequestType(ext) ? ext : declaredType;
		const source = await abortableRequest(
			request(this.url!, type, undefined, undefined, signal),
			signal
		) as Document;
		// A custom/archive request may not honor AbortSignal. Never hand a
		// late response to a caller that already cancelled its work.
		throwIfAborted(signal);
		return source;
	}

	/**
	 * Load an unmodified source document for a canonical-content operation.
	 *
	 * Unlike {@link load}, this method does not retain the document on the
	 * Section or run content hooks. That keeps location/index generation
	 * independent from reader presentation mutations such as annotations and
	 * search wrappers.
	 */
	async loadSource(_request?: RequestFunction, signal?: AbortSignal): Promise<Document> {
		const xml = await this.requestSource(_request, signal);
		if (!xml || !xml.documentElement) {
			throw new TypeError("A canonical source request must resolve to a parsed Document");
		}
		return xml;
	}

	/**
	 * Load raw publication markup without retaining or parsing a source DOM.
	 * Indexers can cheaply reject irrelevant spine items before paying the cost
	 * of XML/HTML parsing, while keeping the same cancellation guarantees as
	 * {@link loadSource}.
	 */
	async loadSourceText(_request?: RequestFunction, signal?: AbortSignal): Promise<string> {
		const request = _request || this.request || Request;
		throwIfAborted(signal);
		const source = await abortableRequest(
			request(this.url!, "text", undefined, undefined, signal),
			signal
		);
		throwIfAborted(signal);
		if (typeof source !== "string") {
			throw new TypeError("A raw source request must resolve to text");
		}
		return source;
	}

	/**
	 * Load the section from its url
	 * @param  {method} [_request] a request method to use for loading
	 * @return {document} a promise with the xml document
	 */
	async load(_request?: RequestFunction, signal?: AbortSignal): Promise<Element> {
		if(this.contents) {
			throwIfAborted(signal);
			return this.contents;
		}

		const xml = await this.requestSource(_request, signal);

		this.document = xml;
		this.contents = xml.documentElement;

		try {
			await abortableRequest(
				this.hooks!.content.trigger(this.document, this),
				signal
			);
			throwIfAborted(signal);
			return this.contents;
		} catch (error) {
			// Never cache a half-transformed source document. A retry must execute
			// the content hooks again rather than publishing partial markup.
			if (this.document === xml) this.unload();
			throw error;
		}
	}

	/**
	 * Adds a base tag for resolving urls in the section
	 * @private
	 */
	base(): void {
		return replaceBase(this.document!, this as unknown as { url: string });
	}

	/**
	 * Render the contents of a section
	 * @param  {method} [_request] a request method to use for loading
	 * @return {string} output a serialized XML Document
	 */
	async render(_request?: RequestFunction, signal?: AbortSignal): Promise<string> {
		const contents = await this.load(_request, signal);
		const serializer = new XMLSerializer();
		const serialized = serializer.serializeToString(contents);
		this.output = serialized;

		try {
			await abortableRequest(
				this.hooks!.serialize.trigger(this.output, this),
				signal
			);
			throwIfAborted(signal);
			return this.output;
		} catch (error) {
			if (this.output === serialized) this.output = undefined;
			throw error;
		}
	}

	/**
	 * Find a string in a section
	 * @param  {string} _query The query string to find
	 * @return {object[]} A list of matches, with form {cfi, excerpt}
	 */
	find(_query: string): SearchResult[] {
		const section = this;
		const matches: SearchResult[] = [];
		const query = _query.toLowerCase();
		const find = function(node: Node): void {
			const text = node.textContent!.toLowerCase();
			let range: Range;
			let cfi;
			let pos;
			let last = -1;
			let excerpt;
			const limit = 150;

			while (pos !== -1) {
				// Search for the query
				pos = text.indexOf(query, last + 1);

				if (pos !== -1) {
					// We found it! Generate a CFI
					range = section.document!.createRange();
					range.setStart(node, pos);
					range.setEnd(node, pos + query.length);

					cfi = section.cfiFromRange(range);

					// Generate the excerpt
					if (node.textContent!.length < limit) {
						excerpt = node.textContent!;
					}
					else {
						excerpt = node.textContent!.substring(pos - limit/2, pos + limit/2);
						excerpt = "..." + excerpt + "...";
					}

					// Add the CFI to the matches list
					matches.push({
						cfi: cfi,
						excerpt: excerpt
					});
				}

				last = pos;
			}
		};

		sprint(section.document!, function(node) {
			find(node);
		});

		return matches;
	};


	/**
	 * Search a string in multiple sequential Element of the section.
	 * @param  {string} _query The query string to search
	 * @param  {int} maxSeqEle The maximum number of Element that are combined for search, default value is 5.
	 * @return {object[]} A list of matches, with form {cfi, excerpt}
	 */
	search(_query: string, maxSeqEle: number = 5): SearchResult[] {
		const matches: SearchResult[] = [];
		const excerptLimit = 150;
		const section = this;
		const query = _query.toLowerCase();
		const search = function(nodeList: Node[]): void {
			const textWithCase =  nodeList.reduce((acc: string ,current: Node)=>{
				return acc + (current.textContent ?? "");
			},"");
			const text = textWithCase.toLowerCase();
			const pos = text.indexOf(query);
			if (pos !== -1){
				const startNodeIndex = 0 , endPos = pos + query.length;
				let endNodeIndex = 0 , l = 0;
				if (pos < (nodeList[startNodeIndex] as Text).length){
					while( endNodeIndex < nodeList.length - 1 ){
						l += (nodeList[endNodeIndex] as Text).length;
						if ( endPos <= l){
							break;
						}
						endNodeIndex += 1;
					}

					const startNode = nodeList[startNodeIndex]! , endNode = nodeList[endNodeIndex]!;
					const range = section.document!.createRange();
					range.setStart(startNode,pos);
					const beforeEndLengthCount =  nodeList.slice(0, endNodeIndex).reduce((acc: number,current: Node)=>{return acc+(current.textContent ?? "").length;},0) ;
					range.setEnd(endNode, beforeEndLengthCount > endPos ? endPos : endPos - beforeEndLengthCount );
					const cfi = section.cfiFromRange(range);

					let excerpt = nodeList.slice(0, endNodeIndex+1).reduce((acc: string,current: Node)=>{return acc+(current.textContent ?? "") ;},"");
					if (excerpt.length > excerptLimit){
						excerpt = excerpt.substring(pos - excerptLimit/2, pos + excerptLimit/2);
						excerpt = "..." + excerpt + "...";
					}
					matches.push({
						cfi: cfi,
						excerpt: excerpt
					});
				}
			}
		}

		// Sections can belong to an iframe/source document rather than the host
		// page. Using the global document here made cross-realm searches fail in
		// Firefox with `Document.createTreeWalker: Argument 1 is not an object`.
		const sectionDocument = section.document!;
		const nodeFilter = sectionDocument.defaultView?.NodeFilter ?? NodeFilter;
		const treeWalker = sectionDocument.createTreeWalker(
			sectionDocument,
			nodeFilter.SHOW_TEXT,
			null
		);
		let node: Node | null , nodeList: Node[] = [];
		while ((node = treeWalker.nextNode())) {
			nodeList.push(node);
			if (nodeList.length === maxSeqEle){
				search(nodeList.slice(0 , maxSeqEle));
				nodeList = nodeList.slice(1, maxSeqEle);
			}
		}
		if (nodeList.length > 0){
			search(nodeList);
		}
		return matches;
	}

	/**
	* Reconciles the current chapters layout properties with
	* the global layout properties.
	* @param {object} globalLayout  The global layout settings object, chapter properties string
	* @return {object} layoutProperties Object with layout properties
	*/
	reconcileLayoutSettings(globalLayout: GlobalLayout): Record<string, string> {
		//-- Get the global defaults
		const settings: Record<string, string> = {
			layout : globalLayout.layout,
			spread : globalLayout.spread,
			orientation : globalLayout.orientation
		};

		//-- Get the chapter's display type
		this.properties!.forEach(function(prop){
			const rendition = prop.replace("rendition:", "");
			const split = rendition.indexOf("-");
			let property, value;

			if(split !== -1){
				property = rendition.slice(0, split);
				value = rendition.slice(split+1);

				settings[property] = value;
			}
		});
		return settings;
	}

	/**
	 * Get a CFI from a Range in the Section
	 * @param  {range} _range
	 * @return {string} cfi an EpubCFI string
	 */
	cfiFromRange(_range: Range): string {
		return new EpubCFI(_range, this.cfiBase).toString();
	}

	/**
	 * Get a CFI from an Element in the Section
	 * @param  {element} el
	 * @return {string} cfi an EpubCFI string
	 */
	cfiFromElement(el: Element): string {
		return new EpubCFI(el, this.cfiBase).toString();
	}

	/**
	 * Unload the section document
	 */
	unload(): void {
		this.document = undefined;
		this.contents = undefined;
		this.output = undefined;
	}

	destroy(): void {
		this.unload();
		this.hooks!.serialize.clear();
		this.hooks!.content.clear();

		this.hooks = undefined;
		this.idref = undefined;
		this.linear = undefined;
		this.properties = undefined;
		this.index = undefined;
		this.href = undefined;
		this.url = undefined;
		this.next = undefined;
		this.prev = undefined;

		this.cfiBase = undefined;
	}
}

export default Section;

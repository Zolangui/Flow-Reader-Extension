import Contents from '../../contents'
import EpubCFI from '../../epubcfi'
import type Layout from '../../layout'
import { sectionLayoutName } from '../../layout'
import type { Mark } from '../../marks-pane'
import { Pane, Highlight, Underline } from '../../marks-pane'
import {
  createPaginationLifecycleArtifacts,
  PAGINATION_LIFECYCLE_VERSION,
  type PaginationLifecycleContext,
  type PaginationLifecycleArtifacts,
} from '../../pagination-lifecycle'
import type Section from '../../section'
import type {
  IEventEmitter,
  ViewSettings,
  ReframeBounds,
  RequestFunction,
} from '../../types'
import { EVENTS } from '../../utils/constants'
import {
  extend,
  borders,
  uuid,
  isNumber,
  bounds,
  defer,
  createBlobUrl,
  revokeBlobUrl,
} from '../../utils/core'
import EventEmitter from '../../utils/event-emitter'

export interface IframeViewEvents extends Record<string, any[]> {
  axis: [string]
  writingMode: [string]
  loaderror: [unknown]
  rendered: [Section]
  resized: [ReframeBounds]
  displayed: [IframeView]
  shown: [IframeView]
  hidden: [IframeView]
  markClicked: [string, object | undefined]
}

/**
 * A renderer-local count of authored content leaves before a manager adds
 * physical parity blanks. It is intentionally not a publication progress
 * coordinate: callers combine it with spine order and spread semantics in a
 * Layout Atlas.
 */
export interface ContentLeafMeasurement {
  layout: 'reflowable' | 'pre-paginated'
  flow: 'paginated' | 'roll'
  axis: 'horizontal' | 'vertical'
  /** Effective viewport shape after the section's writing mode is known. */
  viewportMode: 'single' | 'two-up'
  /**
   * Extent reported by Contents before column snapping or parity padding.
   * Null when a discrete extent does not apply (fixed or rolling content).
   */
  rawExtent: number | null
  /**
   * Width/height occupied by one reflowable leaf. Null when not applicable.
   */
  leafExtent: number | null
  /** Authored content leaves only; never includes a synthetic blank. */
  leafCount: number
}

class IframeView implements IEventEmitter<IframeViewEvents> {
  settings: ViewSettings
  id: string
  section: Section
  index: number
  element: HTMLElement
  added: boolean
  displayed: boolean
  rendered: boolean
  fixedWidth: number
  fixedHeight: number
  epubcfi: EpubCFI
  layout: Layout
  pane: Pane | undefined
  highlights: Record<
    string,
    {
      mark: Mark
      element: SVGElement | null
      listeners: (EventListener | undefined)[]
    }
  >
  underlines: Record<
    string,
    {
      mark: Mark
      element: SVGElement | null
      listeners: (EventListener | undefined)[]
    }
  >
  marks: Record<
    string,
    {
      element: HTMLAnchorElement
      range: Range
      listeners: (EventListener | undefined)[]
    }
  >
  iframe: HTMLIFrameElement | undefined
  resizing!: boolean
  _width: number | undefined
  _height: number | undefined
  _textWidth: number | undefined
  _textHeight: number | undefined
  _contentWidth: number | undefined
  _contentHeight: number | undefined
  _contentDirty = true
  _needsReframe = false
  _expanding = false
  elementBounds!: { width: number; height: number }
  supportsSrcdoc!: boolean
  sectionRender: Promise<string> | undefined
  lockedWidth!: number
  lockedHeight!: number
  prevBounds: ReframeBounds | undefined
  blobUrl?: string
  document!: Document
  window!: Window
  contents: Contents | undefined
  rendering!: boolean
  writingMode!: string
  stopExpanding!: boolean
  axis!: string
  private paginationArtifacts: PaginationLifecycleArtifacts
  expanded?: boolean
  _abortController: AbortController | undefined
  _displaying: Promise<IframeView> | undefined
  _loading:
    | {
        resolve: (value: Contents | PromiseLike<Contents>) => void
        reject: (reason?: unknown) => void
      }
    | undefined
  _disposed = false
  _renderEpoch = 0

  declare on: IEventEmitter<IframeViewEvents>['on']
  declare off: IEventEmitter<IframeViewEvents>['off']
  declare emit: IEventEmitter<IframeViewEvents>['emit']
  declare __listeners: IEventEmitter<IframeViewEvents>['__listeners']

  constructor(section: Section, options?: ViewSettings) {
    this.settings = extend(
      {
        ignoreClass: '',
        axis: undefined, //options.layout && options.layout.props.flow === "scrolled" ? "vertical" : "horizontal",
        direction: undefined,
        width: 0,
        height: 0,
        layout: undefined,
        globalLayoutProperties: {},
        method: undefined,
        forceRight: false,
        forcePageSpread: undefined,
        allowScriptedContent: false,
        allowPopups: false,
      } as ViewSettings,
      options || {},
    )

    this.id = 'epubjs-view-' + uuid()
    this.section = section
    this.index = section.index!

    this.element = this.container(this.settings.axis)

    this.added = false
    this.displayed = false
    this.rendered = false

    // this.width  = this.settings.width;
    // this.height = this.settings.height;

    this.fixedWidth = 0
    this.fixedHeight = 0

    // Blank Cfi for Parsing
    this.epubcfi = new EpubCFI()

    this.layout = this.settings.layout as unknown as Layout
    this.paginationArtifacts = createPaginationLifecycleArtifacts()
    // Dom events to listen for
    // this.listenedEvents = ["keydown", "keyup", "keypressed", "mouseup", "mousedown", "click", "touchend", "touchstart"];

    this.pane = undefined
    this.highlights = {}
    this.underlines = {}
    this.marks = {}
  }

  private abortError(): DOMException {
    return new DOMException('Iframe view was released', 'AbortError')
  }

  private isCurrentRender(epoch: number, signal?: AbortSignal): boolean {
    return !this._disposed && this._renderEpoch === epoch && !signal?.aborted
  }

  private assertCurrentRender(epoch: number, signal?: AbortSignal): void {
    if (!this.isCurrentRender(epoch, signal)) {
      throw this.abortError()
    }
  }

  private paginationContext(): PaginationLifecycleContext {
    if (!this.contents) {
      throw new Error('Pagination lifecycle requires loaded iframe contents')
    }
    return {
      lifecycleVersion: PAGINATION_LIFECYCLE_VERSION,
      purpose: this.settings.paginationPurpose ?? 'reader',
      view: this,
      section: this.section,
      contents: this.contents,
      layout: this.layout,
      axis: this.axis,
      writingMode: this.writingMode,
      artifacts: this.paginationArtifacts,
    }
  }

  getPaginationLifecycleArtifacts(): PaginationLifecycleArtifacts {
    return {
      artifactsVersion: this.paginationArtifacts.artifactsVersion,
      expectedGeometryProducerIds: [
        ...this.paginationArtifacts.expectedGeometryProducerIds,
      ],
      geometry: this.paginationArtifacts.geometry.map((artifact) => ({
        ...artifact,
      })),
    }
  }

  /** Race lifecycle work with view disposal even when a hook ignores signal. */
  private runPaginationLifecycle<T>(
    operation: (() => T | Promise<T>) | undefined,
    epoch: number,
    signal?: AbortSignal,
  ): Promise<T | undefined> {
    this.assertCurrentRender(epoch, signal)
    if (!operation) return Promise.resolve(undefined)

    const execution = Promise.resolve().then(operation)
    if (!signal) {
      return execution.then((value) => {
        this.assertCurrentRender(epoch)
        return value
      })
    }

    return new Promise<T>((resolve, reject) => {
      let settled = false
      const cleanup = (): void => signal.removeEventListener('abort', onAbort)
      const onAbort = (): void => {
        if (settled) return
        settled = true
        cleanup()
        reject(this.abortError())
      }

      signal.addEventListener('abort', onAbort, { once: true })
      execution.then(
        (value) => {
          if (settled) return
          settled = true
          cleanup()
          try {
            this.assertCurrentRender(epoch, signal)
            resolve(value)
          } catch (error) {
            reject(error)
          }
        },
        (error: unknown) => {
          if (settled) return
          settled = true
          cleanup()
          reject(error)
        },
      )
    })
  }

  private get isFixedLayout(): boolean {
    return sectionLayoutName(this.section, this.layout.name) === 'pre-paginated'
  }

  container(axis?: string): HTMLElement {
    const element = document.createElement('div')

    element.classList.add('epub-view')

    // this.element.style.minHeight = "100px";
    element.style.height = '0px'
    element.style.width = '0px'
    element.style.overflow = 'hidden'
    element.style.position = 'relative'
    element.style.display = 'block'
    // Isolate each view's reflow/paint from its siblings. Do NOT include
    // `size` — `expand()` needs to read the content's natural dimensions.
    element.style.contain = 'layout paint'

    if (axis && axis === 'horizontal') {
      element.style.flex = 'none'
    } else {
      element.style.flex = 'initial'
    }

    return element
  }

  create(): HTMLIFrameElement {
    if (this._disposed) {
      throw this.abortError()
    }

    if (this.iframe) {
      return this.iframe
    }

    if (!this.element) {
      this.element = this.container()
    }

    this.iframe = document.createElement('iframe')
    this.iframe.id = this.id
    this.iframe.scrolling = 'no' // Might need to be removed: breaks ios width calculations
    this.iframe.style.overflow = 'hidden'
    this.iframe.setAttribute('seamless', 'seamless')
    // Back up if seamless isn't supported
    this.iframe.style.border = 'none'

    // sandbox
    this.iframe.sandbox = 'allow-same-origin'
    if (this.settings.allowScriptedContent) {
      this.iframe.sandbox += ' allow-scripts'
    }
    if (this.settings.allowPopups) {
      this.iframe.sandbox += ' allow-popups'
    }

    this.iframe.setAttribute('enable-annotation', 'true')

    this.resizing = true

    // this.iframe.style.display = "none";
    this.element.style.visibility = 'hidden'
    this.iframe.style.visibility = 'hidden'

    this.iframe.style.width = '0'
    this.iframe.style.height = '0'
    this._width = 0
    this._height = 0

    this.element.setAttribute('ref', String(this.index))

    this.added = true

    this.elementBounds = bounds(this.element)

    // if(width || height){
    //   this.resize(width, height);
    // } else if(this.width && this.height){
    //   this.resize(this.width, this.height);
    // } else {
    //   this.iframeBounds = bounds(this.iframe);
    // }

    if ('srcdoc' in this.iframe) {
      this.supportsSrcdoc = true
    } else {
      this.supportsSrcdoc = false
    }

    if (!this.settings.method) {
      // srcdoc is implemented by every browser supported by the extension.
      // Do not retain a legacy dynamic-document fallback merely for feature
      // detection: strict extension CSPs require the safe navigation path.
      this.settings.method = 'srcdoc'
    }

    return this.iframe
  }

  render(request: RequestFunction, _show?: boolean): Promise<void> {
    if (this._disposed) {
      return Promise.reject(this.abortError())
    }

    const epoch = this._renderEpoch

    // view.onLayout = this.layout.format.bind(this.layout);
    this.create()

    // Fit to size of the container, apply padding
    this.size()

    if (typeof AbortController !== 'undefined' && !this._abortController) {
      this._abortController = new AbortController()
    }
    const signal = this._abortController?.signal
    let presentationCandidate: unknown
    this.paginationArtifacts = createPaginationLifecycleArtifacts(
      this.settings.paginationLifecycle?.geometryProducerIds?.(),
    )

    const sectionRender =
      this.sectionRender ||
      (this.sectionRender = this.section.render(request, signal))

    // Render Chain
    return sectionRender
      .then((contents: string) => {
        this.assertCurrentRender(epoch, signal)
        return this.load(contents, epoch)
      })
      .then(async () => {
        this.assertCurrentRender(epoch, signal)
        if (!this.contents) {
          throw new Error('Iframe contents were not loaded')
        }

        // find and report the writingMode axis
        const writingMode = this.contents.writingMode()

        // Set the axis based on the flow and writing mode
        let axis
        if (this.settings.flow === 'scrolled') {
          axis = writingMode.startsWith('vertical') ? 'horizontal' : 'vertical'
        } else {
          axis = writingMode.startsWith('vertical') ? 'vertical' : 'horizontal'
        }

        if (
          writingMode.startsWith('vertical') &&
          this.settings.flow === 'paginated'
        ) {
          this.layout.delta = this.layout.height
        }

        this.setAxis(axis)
        this.emit(EVENTS.VIEWS.AXIS, axis)

        this.setWritingMode(writingMode)
        this.emit(EVENTS.VIEWS.WRITING_MODE, writingMode)

        // Host theme, typography and image-fit rules must exist before LPE
        // inspects the final iframe and before Layout.format measures it.
        await this.runPaginationLifecycle(
          () =>
            this.settings.paginationLifecycle?.preparePagination?.(
              this.paginationContext(),
              signal,
            ),
          epoch,
          signal,
        )
        this.assertCurrentRender(epoch, signal)

        // The final, measurable iframe remains visibility-hidden throughout
        // both lifecycle boundaries. No adaptive handler is registered by
        // default; phase 2 only establishes the cancellable transaction.
        presentationCandidate = await this.runPaginationLifecycle(
          () =>
            this.settings.paginationLifecycle?.beforePagination?.(
              this.paginationContext(),
              signal,
            ),
          epoch,
          signal,
        )
        this.assertCurrentRender(epoch, signal)

        // Apply the real Lumen layout to the same iframe that will be shown.
        this.layout.format(this.contents, this.section, this.axis)

        // Listen for events that require an expansion of the iframe
        this.addListeners()

        // Expand the iframe to the full size of the paginated content.
        this.expand()

        const forcedPageSpread =
          this.settings.forcePageSpread ??
          (this.settings.forceRight ? 'right' : undefined)
        if (forcedPageSpread === 'left') {
          this.element.style.marginRight = this.width() + 'px'
        } else if (forcedPageSpread === 'right') {
          this.element.style.marginLeft = this.width() + 'px'
        } else if (forcedPageSpread === 'center') {
          const halfPage = this.width() / 2 + 'px'
          this.element.style.marginLeft = halfPage
          this.element.style.marginRight = halfPage
        }
      })
      .then(async () => {
        this.assertCurrentRender(epoch, signal)
        await this.runPaginationLifecycle(
          () =>
            this.settings.paginationLifecycle?.afterPagination?.(
              this.paginationContext(),
              presentationCandidate,
              signal,
            ),
          epoch,
          signal,
        )
      })
      .catch((error: unknown) => {
        if (
          !this.isCurrentRender(epoch, signal) ||
          (error as { name?: string }).name === 'AbortError'
        ) {
          throw error
        }
        this.emit(EVENTS.VIEWS.LOAD_ERROR, error)
        throw error
      })
      .then(() => {
        this.assertCurrentRender(epoch, signal)
        this.emit(EVENTS.VIEWS.RENDERED, this.section)
      })
  }

  reset(): void {
    if (this.iframe) {
      this.iframe.style.width = '0'
      this.iframe.style.height = '0'
      this._width = 0
      this._height = 0
      this._textWidth = undefined
      this._contentWidth = undefined
      this._textHeight = undefined
      this._contentHeight = undefined
    }
    this._contentDirty = true
    this._needsReframe = true
  }

  // Determine locks base on settings
  size(_width?: number, _height?: number): void {
    const width = _width || this.settings.width!
    const height = _height || this.settings.height!

    if (this.isFixedLayout) {
      this.lock('both', width, height)
    } else if (this.settings.axis === 'horizontal') {
      this.lock('height', width, height)
    } else {
      this.lock('width', width, height)
    }

    this.settings.width = width
    this.settings.height = height
  }

  // Lock an axis to element dimensions, taking borders into account
  lock(what: string, width: number, height: number): void {
    const elBorders = borders(this.element)
    let iframeBorders

    if (this.iframe) {
      iframeBorders = borders(this.iframe)
    } else {
      iframeBorders = { width: 0, height: 0 }
    }

    if (what === 'width' && isNumber(width)) {
      this.lockedWidth = width - elBorders.width - iframeBorders.width
      // this.resize(this.lockedWidth, width); //  width keeps ratio correct
    }

    if (what === 'height' && isNumber(height)) {
      this.lockedHeight = height - elBorders.height - iframeBorders.height
      // this.resize(width, this.lockedHeight);
    }

    if (what === 'both' && isNumber(width) && isNumber(height)) {
      this.lockedWidth = width - elBorders.width - iframeBorders.width
      this.lockedHeight = height - elBorders.height - iframeBorders.height
      // this.resize(this.lockedWidth, this.lockedHeight);
    }

    if (this.displayed && this.iframe) {
      // this.contents.layout();
      this.expand()
    }
  }

  // Resize a single axis based on content dimensions
  expand(force = false): void {
    let width = this.lockedWidth
    let height = this.lockedHeight
    let columns

    if (!this.iframe || this._expanding) return

    if (force) {
      this._contentDirty = true
      this._textWidth = undefined
      this._textHeight = undefined
    }

    this._expanding = true

    if (this.isFixedLayout) {
      width = this.layout.columnWidth
      height = this.layout.height
    }
    // Expand Horizontally
    else if (this.settings.axis === 'horizontal') {
      // Use cached text width when content hasn't changed (avoids synchronous reflow)
      if (!this._contentDirty && this._textWidth !== undefined) {
        width = this._textWidth
      } else {
        width = this.contents!.textWidth()
        this._textWidth = width
        this._contentDirty = false
      }

      if (width % this.layout.pageWidth > 0) {
        width = Math.ceil(width / this.layout.pageWidth) * this.layout.pageWidth
      }

      if (this.settings.forceEvenPages) {
        columns = width / this.layout.pageWidth
        if (this.layout.divisor > 1 && !this.isFixedLayout && columns % 2 > 0) {
          // add a blank page
          width += this.layout.pageWidth
        }
      }
    } // Expand Vertically
    else if (this.settings.axis === 'vertical') {
      // Use cached text height when content hasn't changed (avoids synchronous reflow)
      if (!this._contentDirty && this._textHeight !== undefined) {
        height = this._textHeight
      } else {
        height = this.contents!.textHeight()
        this._textHeight = height
        this._contentDirty = false
      }

      if (
        this.settings.flow === 'paginated' &&
        height % this.layout.height > 0
      ) {
        height = Math.ceil(height / this.layout.height) * this.layout.height
      }
    }

    // Only Resize if dimensions have changed or
    // if Frame is still hidden, so needs reframing
    if (
      this._needsReframe ||
      width !== this._width ||
      height !== this._height
    ) {
      this.reframe(width, height)
    }

    this._expanding = false
  }

  /**
   * Measure content leaves without observing the outer iframe dimensions.
   *
   * `expand()` deliberately widens an odd reflowable section when
   * `forceEvenPages` is enabled. That behavior is correct for the visible
   * default manager, but an atlas must receive the pre-padding content count
   * so its spread planner can own synthetic blanks exactly once.
   *
   * Call after the document has been styled and layout has settled. The
   * method reads Contents directly instead of `_textWidth`/`_textHeight`,
   * whose cache can represent an earlier font or image layout.
   */
  measureContentLeaves(): ContentLeafMeasurement {
    if (!this.contents) {
      throw new Error(
        'Cannot measure content leaves before iframe contents are loaded',
      )
    }

    const layout = this.layout
    if (!layout) {
      throw new Error('Cannot measure content leaves without a layout')
    }

    const axis: ContentLeafMeasurement['axis'] =
      this.settings.axis === 'vertical' ? 'vertical' : 'horizontal'
    const configuredFlow = this.settings.flow
    const layoutFlow = layout.props?.flow
    const flow: ContentLeafMeasurement['flow'] =
      layoutFlow === 'scrolled' ||
      (layoutFlow !== 'paginated' &&
        (configuredFlow === 'scrolled' ||
          configuredFlow === 'scrolled-doc' ||
          configuredFlow === 'scrolled-continuous'))
        ? 'roll'
        : 'paginated'
    const viewportMode: ContentLeafMeasurement['viewportMode'] =
      axis === 'horizontal' && layout.divisor > 1 ? 'two-up' : 'single'
    const layoutName: ContentLeafMeasurement['layout'] = this.isFixedLayout
      ? 'pre-paginated'
      : 'reflowable'

    // Fixed-layout spine items remain discrete authored pages even when the
    // surrounding rendition uses a scrolled flow. Layout.format() handles
    // their `fit()` path first, so the Atlas must do the same.
    if (layoutName === 'pre-paginated') {
      return {
        layout: layoutName,
        flow: 'paginated',
        axis,
        viewportMode,
        rawExtent: null,
        leafExtent: null,
        leafCount: 1,
      }
    }

    if (flow === 'roll') {
      return {
        layout: layoutName,
        flow,
        axis,
        viewportMode,
        rawExtent: null,
        leafExtent: null,
        leafCount: 0,
      }
    }

    const leafExtent = axis === 'horizontal' ? layout.pageWidth : layout.height
    if (
      !(typeof leafExtent === 'number') ||
      !Number.isFinite(leafExtent) ||
      leafExtent <= 0
    ) {
      throw new Error(
        'Cannot measure reflowable content leaves without a positive page extent',
      )
    }

    const measuredExtent =
      axis === 'horizontal'
        ? this.contents.textWidth()
        : this.contents.textHeight()
    const rawExtent = Number.isFinite(measuredExtent)
      ? Math.max(0, measuredExtent)
      : 0

    return {
      layout: layoutName,
      flow,
      axis,
      viewportMode,
      rawExtent,
      leafExtent,
      leafCount: rawExtent > 0 ? Math.ceil(rawExtent / leafExtent) : 0,
    }
  }

  reframe(width: number, height: number): void {
    if (isNumber(width)) {
      this.element.style.width = width + 'px'
      this.iframe!.style.width = width + 'px'
      this._width = width
    }

    if (isNumber(height)) {
      this.element.style.height = height + 'px'
      this.iframe!.style.height = height + 'px'
      this._height = height
    }

    const widthDelta = this.prevBounds ? width - this.prevBounds.width : width
    const heightDelta = this.prevBounds
      ? height - this.prevBounds.height
      : height

    const size = {
      width: width,
      height: height,
      widthDelta: widthDelta,
      heightDelta: heightDelta,
    }

    this.pane && this.pane.render()

    requestAnimationFrame(() => {
      let mark
      for (const m in this.marks) {
        if (Object.prototype.hasOwnProperty.call(this.marks, m)) {
          mark = this.marks[m]!
          this.placeMark(mark.element, mark.range)
        }
      }
    })

    this.onResize(this, size)

    this.emit(EVENTS.VIEWS.RESIZED, size)

    this.prevBounds = size

    this.elementBounds = bounds(this.element)
  }

  load(contents: string, epoch = this._renderEpoch): Promise<Contents> {
    if (!this.isCurrentRender(epoch)) {
      return Promise.reject(this.abortError())
    }

    const loading = new defer<Contents>()
    const loaded = loading.promise
    this._loading = loading

    const iframe = this.iframe
    if (!iframe) {
      this._loading = undefined
      loading.reject(new Error('No Iframe Available'))
      return loaded
    }

    const onload = (event: Event): void => {
      this.onLoad(event, loading, epoch, iframe)
    }

    if (this.settings.method === 'blobUrl') {
      iframe.onload = onload
      // A view can be re-displayed while its first load is still in flight —
      // the continuous manager reuses instances — so drop the previous blob
      // instead of orphaning it for the lifetime of the document.
      if (this.blobUrl) {
        revokeBlobUrl(this.blobUrl)
      }
      this.blobUrl = createBlobUrl(contents, 'application/xhtml+xml')
      iframe.src = this.blobUrl
      this.element.appendChild(iframe)
    } else if (this.settings.method === 'srcdoc') {
      iframe.onload = onload
      iframe.srcdoc = contents
      this.element.appendChild(iframe)
    } else {
      // Every browser supported by Lumen implements srcdoc. Keeping even an
      // unreachable dynamic-document fallback in the shipped source triggers
      // Firefox extension security review and is unnecessary for EPUB content.
      iframe.onload = onload
      iframe.srcdoc = contents
      this.element.appendChild(iframe)
    }

    return loaded
  }

  onLoad(
    event: Event,
    promise: {
      resolve: (value: Contents | PromiseLike<Contents>) => void
      reject: (reason?: unknown) => void
    },
    epoch = this._renderEpoch,
    iframe = this.iframe,
  ): void {
    if (!iframe || iframe !== this.iframe || !this.isCurrentRender(epoch)) {
      if (this._loading === promise) {
        this._loading = undefined
      }
      promise.reject(this.abortError())
      return
    }

    this.window = iframe.contentWindow!
    this.document = iframe.contentDocument!
    if (!this.document || !this.document.body) {
      if (this._loading === promise) {
        this._loading = undefined
      }
      promise.reject(new Error('Iframe document is unavailable'))
      return
    }

    this.contents = new Contents(
      this.document,
      this.document.body,
      this.section.cfiBase,
      this.section.index,
    )

    this.rendering = false

    let link = this.document.querySelector("link[rel='canonical']")
    if (link) {
      link.setAttribute('href', this.section.canonical)
    } else {
      link = this.document.createElement('link')
      link.setAttribute('rel', 'canonical')
      link.setAttribute('href', this.section.canonical)
      this.document.querySelector('head')!.appendChild(link)
    }

    this.contents.on(EVENTS.CONTENTS.EXPAND, () => {
      if (this.displayed && this.iframe) {
        this._contentDirty = true
        this.expand()
        if (this.contents) {
          this.layout.format(this.contents, this.section)
        }
      }
    })

    this.contents.on(
      EVENTS.CONTENTS.RESIZE,
      (e: { width: number; height: number }) => {
        if (this.displayed && this.iframe) {
          // Pre-populate cache with values already measured by resizeCheck(),
          // avoiding a redundant reflow when expand() runs next
          this._textWidth = e.width
          this._textHeight = e.height
          this._contentDirty = false
          this.expand()
          if (this.contents) {
            this.layout.format(this.contents, this.section)
          }
        }
      },
    )

    if (this._loading === promise) {
      this._loading = undefined
    }
    promise.resolve(this.contents)
  }

  setLayout(layout: Layout): void {
    this.layout = layout

    if (this.contents) {
      this.layout.format(this.contents, this.section)
      this._contentDirty = true
      this.expand()
    }
  }

  setAxis(axis: string): void {
    this.axis = axis
    this.settings.axis = axis

    if (axis === 'horizontal') {
      this.element.style.flex = 'none'
    } else {
      this.element.style.flex = 'initial'
    }

    this.size()
  }

  setWritingMode(mode: string): void {
    // this.element.style.writingMode = writingMode;
    this.writingMode = mode
  }

  addListeners(): void {}

  removeListeners(): void {
    if (this.contents) {
      this.contents.off(EVENTS.CONTENTS.EXPAND)
      this.contents.off(EVENTS.CONTENTS.RESIZE)
    }
  }

  display(request: RequestFunction): Promise<IframeView> {
    if (this._disposed) {
      return Promise.reject(this.abortError())
    }

    if (this.displayed) {
      return Promise.resolve(this)
    }

    // `displayed` only flips once render() resolves, so overlapping calls
    // would each reach load() and overwrite iframe.onload — orphaning every
    // deferred but the last. Share the in-flight promise instead.
    if (this._displaying) {
      return this._displaying
    }

    const displayed = new defer<IframeView>()
    const epoch = this._renderEpoch
    this._displaying = displayed.promise

    this.render(request).then(
      () => {
        try {
          this.assertCurrentRender(epoch)
          // Event observers must see a coherent displayed view. If an
          // observer itself throws, roll the state back and reject the public
          // display promise instead of leaving it pending forever.
          this.displayed = true
          this.emit(EVENTS.VIEWS.DISPLAYED, this)
          this.onDisplayed(this)

          this._displaying = undefined
          displayed.resolve(this)
        } catch (error) {
          this.displayed = false
          this._displaying = undefined
          displayed.reject(error)
        }
      },
      (err) => {
        this._displaying = undefined
        displayed.reject(err)
      },
    )

    return displayed.promise
  }

  show(): void {
    this.element.style.visibility = 'visible'

    if (this.iframe) {
      this.iframe.style.visibility = 'visible'

      // Remind Safari to redraw the iframe
      this.iframe.style.transform = 'translateZ(0)'
      this.iframe.offsetWidth
      this.iframe.style.transform = ''
    }

    this.emit(EVENTS.VIEWS.SHOWN, this)
  }

  hide(): void {
    // this.iframe.style.display = "none";
    this.element.style.visibility = 'hidden'
    if (this.iframe) this.iframe.style.visibility = 'hidden'

    this.stopExpanding = true
    this.emit(EVENTS.VIEWS.HIDDEN, this)
  }

  offset(): { top: number; left: number } {
    return {
      top: this.element.offsetTop,
      left: this.element.offsetLeft,
    }
  }

  width(): number {
    return this._width!
  }

  height(): number {
    return this._height!
  }

  position(): DOMRect {
    return this.element.getBoundingClientRect()
  }

  locationOf(target: string): { left: number; top: number } {
    const targetPos = this.contents!.locationOf(
      target,
      this.settings.ignoreClass,
    )

    return {
      left: targetPos.left,
      top: targetPos.top,
    }
  }

  onDisplayed(_view: IframeView): void {
    // Stub, override with a custom functions
  }

  onResize(_view: IframeView, _e?: ReframeBounds): void {
    // Stub, override with a custom functions
  }

  bounds(force?: boolean): { width: number; height: number } {
    if (force || !this.elementBounds) {
      this.elementBounds = bounds(this.element)
    }

    return this.elementBounds
  }

  highlight(
    cfiRange: string,
    data: Record<string, string> = {},
    cb?: EventListener,
    className = 'epubjs-hl',
    styles: Record<string, string> = {},
  ): Mark | undefined {
    if (!this.contents) {
      return
    }
    const attributes = Object.assign(
      { fill: 'yellow', 'fill-opacity': '0.3', 'mix-blend-mode': 'multiply' },
      styles,
    )
    const range = this.contents.range(cfiRange)

    const emitter: EventListener = (_e: Event): void => {
      this.emit(EVENTS.VIEWS.MARK_CLICKED, cfiRange, data)
    }

    data['epubcfi'] = cfiRange

    if (!this.pane) {
      this.pane = new Pane(this.iframe!, this.element)
    }

    const m = new Highlight(range, className, data, attributes)
    let h: Mark
    try {
      h = this.pane.addMark(m)
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('Failed to add highlight for', cfiRange, e)
      return
    }

    this.highlights[cfiRange] = {
      mark: h,
      element: h.element,
      listeners: [emitter, cb],
    }

    h.element!.setAttribute('ref', className)
    h.element!.addEventListener('click', emitter)
    h.element!.addEventListener('touchstart', emitter)

    if (cb) {
      h.element!.addEventListener('click', cb)
      h.element!.addEventListener('touchstart', cb)
    }
    return h
  }

  underline(
    cfiRange: string,
    data: Record<string, string> = {},
    cb?: EventListener,
    className = 'epubjs-ul',
    styles: Record<string, string> = {},
  ): Mark | undefined {
    if (!this.contents) {
      return
    }
    const attributes = Object.assign(
      {
        stroke: 'black',
        'stroke-opacity': '0.3',
        'mix-blend-mode': 'multiply',
      },
      styles,
    )
    const range = this.contents.range(cfiRange)
    const emitter: EventListener = (_e: Event): void => {
      this.emit(EVENTS.VIEWS.MARK_CLICKED, cfiRange, data)
    }

    data['epubcfi'] = cfiRange

    if (!this.pane) {
      this.pane = new Pane(this.iframe!, this.element)
    }

    const m = new Underline(range, className, data, attributes)
    let h: Mark
    try {
      h = this.pane.addMark(m)
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('Failed to add underline for', cfiRange, e)
      return
    }

    this.underlines[cfiRange] = {
      mark: h,
      element: h.element,
      listeners: [emitter, cb],
    }

    h.element!.setAttribute('ref', className)
    h.element!.addEventListener('click', emitter)
    h.element!.addEventListener('touchstart', emitter)

    if (cb) {
      h.element!.addEventListener('click', cb)
      h.element!.addEventListener('touchstart', cb)
    }
    return h
  }

  mark(
    cfiRange: string,
    data: Record<string, string> = {},
    cb?: EventListener,
  ):
    | Node
    | {
        element: HTMLAnchorElement
        range: Range
        listeners: (EventListener | undefined)[]
      }
    | null
    | undefined {
    if (!this.contents) {
      return
    }

    if (cfiRange in this.marks) {
      const item = this.marks[cfiRange]
      return item
    }

    let range = this.contents.range(cfiRange)
    if (!range) {
      return
    }
    const container = range.commonAncestorContainer
    const parent = container.nodeType === 1 ? container : container.parentNode

    const emitter: EventListener = (_e: Event): void => {
      this.emit(EVENTS.VIEWS.MARK_CLICKED, cfiRange, data)
    }

    if (range.collapsed && container.nodeType === 1) {
      range = new Range()
      range.selectNodeContents(container)
    } else if (range.collapsed) {
      // Webkit doesn't like collapsed ranges
      range = new Range()
      range.selectNodeContents(parent!)
    }

    const mark = this.document.createElement('a')
    mark.setAttribute('ref', 'epubjs-mk')
    mark.style.position = 'absolute'

    mark.dataset['epubcfi'] = cfiRange

    if (data) {
      Object.keys(data).forEach((key) => {
        mark.dataset[key] = data[key]
      })
    }

    if (cb) {
      mark.addEventListener('click', cb)
      mark.addEventListener('touchstart', cb)
    }

    mark.addEventListener('click', emitter)
    mark.addEventListener('touchstart', emitter)

    this.placeMark(mark, range)

    this.element.appendChild(mark)

    this.marks[cfiRange] = {
      element: mark,
      range: range,
      listeners: [emitter, cb],
    }

    return parent
  }

  placeMark(element: HTMLElement, range: Range): void {
    let top, right, left

    if (this.isFixedLayout || this.settings.axis !== 'horizontal') {
      const pos = range.getBoundingClientRect()
      top = pos.top
      right = pos.right
    } else {
      // Element might break columns, so find the left most element
      const rects = range.getClientRects()

      let rect
      for (let i = 0; i !== rects.length; i++) {
        rect = rects[i]!
        if (!left || rect.left < left) {
          left = rect.left
          // right = rect.right;
          right =
            Math.ceil(left / this.layout.props.pageWidth!) *
              this.layout.props.pageWidth! -
            this.layout.gap / 2
          top = rect.top
        }
      }
    }

    element.style.top = `${top}px`
    element.style.left = `${right}px`
  }

  unhighlight(cfiRange: string): void {
    if (cfiRange in this.highlights) {
      const item = this.highlights[cfiRange]!

      this.pane!.removeMark(item.mark)
      item.listeners.forEach((l: EventListener | undefined) => {
        if (l) {
          item.element!.removeEventListener('click', l)
          item.element!.removeEventListener('touchstart', l)
        }
      })
      delete this.highlights[cfiRange]
    }
  }

  ununderline(cfiRange: string): void {
    if (cfiRange in this.underlines) {
      const item = this.underlines[cfiRange]!
      this.pane!.removeMark(item.mark)
      item.listeners.forEach((l: EventListener | undefined) => {
        if (l) {
          item.element!.removeEventListener('click', l)
          item.element!.removeEventListener('touchstart', l)
        }
      })
      delete this.underlines[cfiRange]
    }
  }

  unmark(cfiRange: string): void {
    if (cfiRange in this.marks) {
      const item = this.marks[cfiRange]!
      this.element.removeChild(item.element)
      item.listeners.forEach((l: EventListener | undefined) => {
        if (l) {
          item.element.removeEventListener('click', l)
          item.element.removeEventListener('touchstart', l)
        }
      })
      delete this.marks[cfiRange]
    }
  }

  /**
   * Release the loaded document while keeping this view reusable. The
   * continuous manager intentionally calls this for off-screen chapters.
   */
  unload(): void {
    if (this._disposed) {
      return
    }

    this._renderEpoch++
    this.stopExpanding = true
    this.rendering = false

    if (this._abortController) {
      this._abortController.abort()
      this._abortController = undefined
    }

    this._displaying = undefined
    if (this._loading) {
      this._loading.reject(this.abortError())
      this._loading = undefined
    }

    for (const cfiRange in this.highlights) {
      this.unhighlight(cfiRange)
    }

    for (const cfiRange in this.underlines) {
      this.ununderline(cfiRange)
    }

    for (const cfiRange in this.marks) {
      this.unmark(cfiRange)
    }

    if (this.blobUrl) {
      revokeBlobUrl(this.blobUrl)
      this.blobUrl = undefined
    }

    this.displayed = false
    this.rendered = false
    this.removeListeners()
    this.contents?.destroy()

    const iframe = this.iframe
    if (iframe) {
      iframe.onload = null
      if (this.element.contains(iframe)) {
        this.element.removeChild(iframe)
      }
    }

    if (this.pane) {
      this.pane.element.remove()
      this.pane = undefined
    }

    this.iframe = undefined
    this.contents = undefined
    // A detached iframe can remain fully alive while either of these strong
    // references exists. Releasing both is essential for discarded chapters
    // (and their styles, images and presentation maps) to become collectible.
    this.document = undefined!
    this.window = undefined!
    this.sectionRender = undefined
    this.section.unload()

    this._textWidth = undefined
    this._textHeight = undefined
    this._width = undefined
    this._height = undefined
  }

  /** Permanently release a view that has been removed from its manager. */
  destroy(): void {
    if (this._disposed) {
      return
    }

    this.unload()
    this._disposed = true
    this.__listeners = {}
  }

  /** Alias used by view collections that need an explicit finalizer. */
  dispose(): void {
    this.destroy()
  }
}

EventEmitter(IframeView.prototype)

export default IframeView

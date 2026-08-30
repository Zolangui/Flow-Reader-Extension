/**
 * Stable addresses into an EPUB source document.
 *
 * Source-tree addresses are created from the unmodified document returned by
 * Section.loadSource(). They are shared infrastructure: canonical reading
 * positions and presentation targets remain separate domain models.
 */

import { hashCanonicalJson } from './canonical-json'

export const SOURCE_TREE_MODEL_VERSION = 1 as const
export const SOURCE_SIGNATURE_VERSION = 1 as const

export type SourceNodeKind = 'element' | 'text'

export type SourceTreeAddress = {
  sourceModelVersion: typeof SOURCE_TREE_MODEL_VERSION
  /** Identifies a spine occurrence. An href is not unique in an EPUB spine. */
  spineIndex: number
  nodeKind: SourceNodeKind
  /** Zero-based indexes in each parent's actual childNodes collection. */
  sourcePath: number[]
}

export type AddressableSourceNode = Element | Text

export type SourceTreeVisit = {
  node: AddressableSourceNode
  nodeKind: SourceNodeKind
  sourcePath: readonly number[]
}

export type SourceTreeVisitDecision = 'continue' | 'skip-children' | 'stop'

export type SourceTreeVisitor = (
  visit: SourceTreeVisit,
) => SourceTreeVisitDecision | void

export type CreateSourceTreeAddressOptions = {
  /**
   * Treat an injected one-child container as occupying its authored child's
   * source slot. This is used only for reversible renderer-owned wrappers;
   * ordinary EPUB elements always remain part of the source path.
   */
  isTransparentContainer?: (element: Element) => boolean
}

function isDocument(source: Document | Element): source is Document {
  return source.nodeType === 9
}

function validSpineIndex(spineIndex: number): boolean {
  return Number.isInteger(spineIndex) && spineIndex >= 0
}

/** Select the version-1 source root without relying on the global document. */
export function getSourceTreeRoot(source: Document | Element): Element {
  if (!isDocument(source)) return source

  const root =
    source.body ??
    source.getElementsByTagNameNS('http://www.w3.org/1999/xhtml', 'body')[0] ??
    source.querySelector('body') ??
    source.documentElement

  if (!root) throw new TypeError('Source document does not have a root element')
  return root
}

/** Return the addressable kind without using cross-realm instanceof checks. */
export function getSourceNodeKind(node: Node): SourceNodeKind | undefined {
  if (node.nodeType === 1) return 'element'
  if (node.nodeType === 3) return 'text'
  return undefined
}

/** Preserve the string form historically used by canonical segment IDs. */
export function formatSourceTreePath(sourcePath: readonly number[]): string {
  return sourcePath.length === 0 ? 'root' : sourcePath.join('.')
}

/**
 * Walk addressable nodes while retaining indexes occupied by comments,
 * processing instructions, and other node types.
 */
export function walkSourceTree(
  source: Document | Element,
  visitor: SourceTreeVisitor,
): void {
  const root = getSourceTreeRoot(source)

  const visit = (node: Node, sourcePath: number[]): boolean => {
    const nodeKind = getSourceNodeKind(node)
    if (nodeKind) {
      const decision = visitor({
        node: node as AddressableSourceNode,
        nodeKind,
        sourcePath,
      })
      if (decision === 'stop') return false
      if (decision === 'skip-children') return true
    }

    const children = Array.from(node.childNodes)
    for (let index = 0; index < children.length; index += 1) {
      if (!visit(children[index]!, [...sourcePath, index])) return false
    }
    return true
  }

  visit(root, [])
}

/** Create an occurrence-safe address for a node inside the selected root. */
export function createSourceTreeAddress(
  source: Document | Element,
  node: Node,
  spineIndex: number,
  options: CreateSourceTreeAddressOptions = {},
): SourceTreeAddress {
  if (!validSpineIndex(spineIndex)) {
    throw new RangeError(
      'Source-tree address requires a non-negative spineIndex',
    )
  }

  const nodeKind = getSourceNodeKind(node)
  if (!nodeKind) {
    throw new TypeError('Only Element and Text nodes are source-addressable')
  }

  const root = getSourceTreeRoot(source)
  const sourcePath: number[] = []
  let current: Node = node

  while (current !== root) {
    const parent: Node | null = current.parentNode
    if (!parent) {
      throw new RangeError('Source node is outside the selected source root')
    }

    if (
      parent.nodeType === 1 &&
      options.isTransparentContainer?.(parent as Element) &&
      parent.childNodes.length === 1 &&
      parent.firstChild === current
    ) {
      // The wrapper replaced this authored node at the wrapper's parent. Do
      // not add the wrapper-local child index; the wrapper's own index is the
      // source-equivalent slot added on the next iteration. Fail closed when
      // an allegedly transparent wrapper contains anything else: otherwise
      // multiple runtime nodes could alias the same authored source address.
      current = parent
      continue
    }

    const childIndex = Array.prototype.indexOf.call(parent.childNodes, current)
    if (childIndex < 0) {
      throw new RangeError('Source node is absent from its parent childNodes')
    }
    sourcePath.unshift(childIndex)
    current = parent
  }

  return {
    sourceModelVersion: SOURCE_TREE_MODEL_VERSION,
    spineIndex,
    nodeKind,
    sourcePath,
  }
}

/**
 * Resolve an address only for the expected spine occurrence.
 *
 * Undefined means that the version, occurrence, path, or node kind is stale.
 * Callers must invalidate the dependent artifact; they must not search for a
 * similar node.
 */
export function resolveSourceTreeAddress(
  source: Document | Element,
  address: SourceTreeAddress,
  expectedSpineIndex: number,
): AddressableSourceNode | undefined {
  if (
    address.sourceModelVersion !== SOURCE_TREE_MODEL_VERSION ||
    !validSpineIndex(expectedSpineIndex) ||
    address.spineIndex !== expectedSpineIndex ||
    !Array.isArray(address.sourcePath)
  ) {
    return undefined
  }

  let current: Node = getSourceTreeRoot(source)
  for (const childIndex of address.sourcePath) {
    if (!Number.isInteger(childIndex) || childIndex < 0) return undefined
    const child = current.childNodes.item(childIndex)
    if (!child) return undefined
    current = child
  }

  if (getSourceNodeKind(current) !== address.nodeKind) return undefined
  return current as AddressableSourceNode
}

function sourceElementSignatureTuple(element: Element): unknown[] {
  const compareCodeUnits = (left: string, right: string): number =>
    left < right ? -1 : left > right ? 1 : 0

  const attributes = Array.from(element.attributes)
    .filter(
      (attribute) => !attribute.name.toLowerCase().startsWith('data-lumen-'),
    )
    .map((attribute) => ({
      namespaceUri: attribute.namespaceURI ?? '',
      name: attribute.name,
      value: attribute.value,
    }))
    .sort((left, right) => {
      const namespaceOrder = compareCodeUnits(
        left.namespaceUri,
        right.namespaceUri,
      )
      return namespaceOrder || compareCodeUnits(left.name, right.name)
    })

  return [
    'element',
    element.namespaceURI ?? '',
    element.localName || element.tagName,
    attributes,
    element.childNodes.length,
  ]
}

/**
 * Source Signature v1. Undefined means Web Crypto is unavailable and the
 * dependent presentation plan must remain uncacheable.
 */
export function createSourceNodeSignature(
  node: AddressableSourceNode,
): Promise<string | undefined> {
  const nodeKind = getSourceNodeKind(node)
  if (nodeKind === 'text') {
    return hashCanonicalJson(['text', (node as Text).data])
  }
  if (nodeKind === 'element') {
    return hashCanonicalJson(sourceElementSignatureTuple(node as Element))
  }
  throw new TypeError('Only Element and Text nodes have source signatures')
}

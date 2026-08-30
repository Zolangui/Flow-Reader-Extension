const presentationRuntimeNodes = new WeakSet<Node>()

/** Mark a node created by LPE without trusting author-controlled attributes. */
export function markPresentationRuntimeNode<T extends Node>(node: T): T {
  presentationRuntimeNodes.add(node)
  return node
}

/** Test runtime ownership by object identity, not by EPUB-authored markup. */
export function isPresentationRuntimeNode(node: Node): boolean {
  return presentationRuntimeNodes.has(node)
}

/** Create a CSS-selector-safe, per-application marker outside canonical plans. */
export function createPresentationRuntimeMarker(
  document: Document,
  prefix: string,
  attribute: string,
): string {
  const crypto = document.defaultView?.crypto ?? globalThis.crypto
  if (!crypto?.getRandomValues) {
    throw new Error('Secure randomness is unavailable for presentation markers')
  }
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const bytes = new Uint8Array(16)
    crypto.getRandomValues(bytes)
    const token = Array.from(bytes, (value) =>
      value.toString(16).padStart(2, '0'),
    ).join('')
    const marker = `${prefix}-${token}`
    if (!document.querySelector(`[${attribute}="${marker}"]`)) return marker
  }
  throw new Error('Unable to allocate a collision-free presentation marker')
}

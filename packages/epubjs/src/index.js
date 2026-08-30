// Keep Lumen's public package name stable while the implementation is provided
// by Lumen's locally maintained, API-compatible EPUB engine.
import ePub, { Contents } from '@flow/epub-engine'

const contentElement = (contents) => contents.content || contents.document?.body

/**
 * Preserve Lumen's former iframe-readiness guards. During a fast tab switch or
 * teardown an EPUB iframe can lose its window before epub.ts finishes a layout
 * read. Returning the engine's neutral value prevents that transient state from
 * turning into a reader-wide render failure.
 */
function guardContentsMethod(method, getTarget, fallback) {
  const original = Contents.prototype[method]

  if (typeof original !== 'function') return

  Contents.prototype[method] = function guardedContentsMethod(...args) {
    const target = getTarget(this)

    try {
      if (
        !target ||
        !this.window ||
        typeof this.window.getComputedStyle !== 'function' ||
        !this.window.getComputedStyle(target)
      ) {
        return fallback
      }
    } catch {
      return fallback
    }

    return original.apply(this, args)
  }
}

guardContentsMethod('width', (contents) => contents.content, 0)
guardContentsMethod('height', (contents) => contents.content, 0)
guardContentsMethod('contentWidth', contentElement, 0)
guardContentsMethod('contentHeight', contentElement, 0)
guardContentsMethod('overflow', (contents) => contents.documentElement, '')
guardContentsMethod('overflowX', (contents) => contents.documentElement, '')
guardContentsMethod('overflowY', (contents) => contents.documentElement, '')
guardContentsMethod('css', contentElement, '')
guardContentsMethod('writingMode', contentElement, '')

export default ePub
export * from '@flow/epub-engine'

// epub.js historically exposed these values as an enum. Keeping it here avoids
// a migration of persisted typography preferences and application imports.
export const RenditionSpread = Object.freeze({
  Auto: 'auto',
  None: 'none',
  Always: 'always',
})

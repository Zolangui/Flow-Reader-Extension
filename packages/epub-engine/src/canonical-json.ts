export type CanonicalJsonPrimitive = null | boolean | number | string
export type CanonicalJsonValue =
  | CanonicalJsonPrimitive
  | CanonicalJsonValue[]
  | { [key: string]: CanonicalJsonValue }

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value)
  if (prototype === null) return true

  // A source iframe has its own Object constructor, so comparing only with
  // this realm's Object.prototype rejects otherwise plain probe data. A class
  // instance still has another prototype level and remains unsupported.
  return (
    Object.prototype.toString.call(value) === '[object Object]' &&
    Object.getPrototypeOf(prototype) === null
  )
}

/**
 * Serialize JSON data deterministically for local artifact identities.
 *
 * Object keys are sorted recursively. Unsupported, ambiguous, cyclic, and
 * non-finite values are rejected instead of being silently omitted or coerced.
 */
export function canonicalJson(value: unknown): string {
  const ancestors = new Set<object>()

  const serialize = (current: unknown): string => {
    if (current === null) return 'null'
    if (typeof current === 'string' || typeof current === 'boolean') {
      return JSON.stringify(current)
    }
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) {
        throw new TypeError('Canonical JSON requires finite numbers')
      }
      return JSON.stringify(Object.is(current, -0) ? 0 : current)
    }
    if (typeof current !== 'object') {
      throw new TypeError(`Canonical JSON cannot serialize ${typeof current}`)
    }
    if (ancestors.has(current)) {
      throw new TypeError('Canonical JSON cannot serialize cyclic data')
    }

    ancestors.add(current)
    try {
      if (Array.isArray(current)) {
        return `[${current.map((item) => serialize(item)).join(',')}]`
      }
      if (!isPlainObject(current)) {
        throw new TypeError('Canonical JSON requires plain objects')
      }

      const object = current as Record<string, unknown>
      const keys = Object.keys(object).sort()
      return `{${keys
        .map((key) => `${JSON.stringify(key)}:${serialize(object[key])}`)
        .join(',')}}`
    } finally {
      ancestors.delete(current)
    }
  }

  return serialize(value)
}

export async function sha256Text(value: string): Promise<string | undefined> {
  const subtle = globalThis.crypto?.subtle
  if (!subtle || typeof TextEncoder === 'undefined') return undefined

  try {
    const bytes = new TextEncoder().encode(value)
    const digest = await subtle.digest('SHA-256', bytes)
    const hex = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join('')
    return `sha256:${hex}`
  } catch {
    // The caller treats an unavailable digest as an uncacheable artifact and
    // falls back to Published presentation. Never substitute a weak hash.
    return undefined
  }
}

export function hashCanonicalJson(value: unknown): Promise<string | undefined> {
  return sha256Text(canonicalJson(value))
}

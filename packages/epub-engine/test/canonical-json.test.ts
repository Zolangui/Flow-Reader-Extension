import { webcrypto } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { canonicalJson, hashCanonicalJson } from '../src/canonical-json'

describe('canonical JSON', () => {
  beforeAll(() => vi.stubGlobal('crypto', webcrypto as unknown as Crypto))
  afterAll(() => vi.unstubAllGlobals())

  it('sorts object keys recursively while preserving array order', async () => {
    const first = { z: [{ b: 2, a: 1 }, 3], a: true }
    const reordered = { a: true, z: [{ a: 1, b: 2 }, 3] }

    expect(canonicalJson(first)).toBe(canonicalJson(reordered))
    expect(await hashCanonicalJson(first)).toBe(
      await hashCanonicalJson(reordered),
    )
    expect(await hashCanonicalJson([1, 2])).not.toBe(
      await hashCanonicalJson([2, 1]),
    )
  })

  it('rejects ambiguous, non-JSON, and cyclic values', () => {
    expect(() => canonicalJson({ missing: undefined })).toThrow(TypeError)
    expect(() => canonicalJson(Number.NaN)).toThrow(TypeError)
    expect(() => canonicalJson(new Date())).toThrow(TypeError)
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(() => canonicalJson(cyclic)).toThrow(TypeError)
  })

  it('accepts plain objects from an iframe realm but rejects instances', () => {
    const iframe = document.createElement('iframe')
    document.body.appendChild(iframe)
    const foreignObject = new iframe.contentWindow!.Object() as Record<
      string,
      unknown
    >
    foreignObject.answer = 42

    expect(canonicalJson(foreignObject)).toBe('{"answer":42}')
    expect(() => canonicalJson(new (class Example {})())).toThrow(
      /plain objects/,
    )

    iframe.remove()
  })
})

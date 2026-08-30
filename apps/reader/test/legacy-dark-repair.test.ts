// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'

import type { Contents } from '@flow/epubjs'

import {
  applyLegacyDarkRepair,
  restoreLegacyDarkRepair,
} from '../src/lib/legacy-dark-repair'

describe('legacy dark repair ownership', () => {
  it('restores markers and never deletes authored inline paint', () => {
    document.documentElement.innerHTML = `
      <head></head><body>
        <p id="author" style="color: rgb(20, 20, 20); background-color: rgb(245, 245, 245)">Authored paint</p>
      </body>`
    const contents = { document } as Contents
    const authored = document.querySelector('#author') as HTMLElement
    const original = authored.getAttribute('style')

    applyLegacyDarkRepair(contents, true)
    expect(
      document.querySelector('[data-lumen-legacy-dark-layer]'),
    ).not.toBeNull()
    expect(authored.getAttribute('style')).toBe(original)

    applyLegacyDarkRepair(contents, false)
    expect(document.querySelector('[data-lumen-legacy-dark-layer]')).toBeNull()
    expect(authored.hasAttribute('data-lumen-legacy-dark-target')).toBe(false)
    expect(authored.getAttribute('style')).toBe(original)
    restoreLegacyDarkRepair(document)
  })

  it('repairs neutral nested prose on a neutral light panel', () => {
    document.documentElement.innerHTML = `
      <head></head><body style="background: rgb(36, 41, 46)">
        <section id="panel" style="background-color: rgb(245, 245, 245)">
          <p><em id="prose" style="color: rgb(20, 20, 20)">Nested authored prose</em></p>
        </section>
      </body>`
    const contents = { document } as Contents

    applyLegacyDarkRepair(contents, true)

    const panel = document.querySelector('#panel')!
    const prose = document.querySelector('#prose')!
    expect(panel.hasAttribute('data-lumen-legacy-dark-target')).toBe(true)
    expect(prose.hasAttribute('data-lumen-legacy-dark-target')).toBe(true)
    const css = document.querySelector(
      '[data-lumen-legacy-dark-layer]',
    )?.textContent
    expect(css).toContain('background-color: #374151')
    expect(css).toContain('color: #bfc8ca')
  })

  it('preserves chromatic author colours and readable light surfaces', () => {
    document.documentElement.innerHTML = `
      <head></head><body style="background: rgb(36, 41, 46)">
        <p id="pink" style="color: rgb(230, 0, 126)">Author accent</p>
        <p id="blue" style="color: rgb(20, 30, 90)">Dark chromatic accent</p>
        <p id="card" style="color: rgb(20, 20, 20); background: rgb(255, 235, 240)">Readable card</p>
      </body>`
    const contents = { document } as Contents

    applyLegacyDarkRepair(contents, true)

    for (const id of ['pink', 'blue', 'card']) {
      expect(
        document
          .querySelector(`#${id}`)
          ?.hasAttribute('data-lumen-legacy-dark-target'),
      ).toBe(false)
    }
  })

  it('does not guess inside hidden, translucent or image-backed paint', () => {
    document.documentElement.innerHTML = `
      <head></head><body style="background: rgb(36, 41, 46)">
        <div style="opacity: .5"><p id="translucent" style="color: rgb(20, 20, 20)">Text</p></div>
        <div style="background-image: linear-gradient(black, white)"><p id="image-backed" style="color: rgb(20, 20, 20)">Text</p></div>
        <p id="hidden" style="display: none; color: rgb(20, 20, 20)">Text</p>
      </body>`
    const contents = { document } as Contents

    applyLegacyDarkRepair(contents, true)

    for (const id of ['translucent', 'image-backed', 'hidden']) {
      expect(
        document
          .querySelector(`#${id}`)
          ?.hasAttribute('data-lumen-legacy-dark-target'),
      ).toBe(false)
    }
  })
})

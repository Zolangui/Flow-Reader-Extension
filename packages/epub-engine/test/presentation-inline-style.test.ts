import { describe, expect, it } from 'vitest'

import {
  applyReversibleInlineStyle,
  suspendInlineStyles,
} from '../src/presentation-inline-style'

describe('reversible presentation inline styles', () => {
  it('suspends, resumes, and restores only the owned property', () => {
    const element = document.createElement('p')
    element.style.cssText =
      'color: rgb(10, 20, 30) !important; background-color: white;'
    const override = applyReversibleInlineStyle(
      element,
      'color',
      '#aabbcc',
    )

    expect(override.isApplied()).toBe(true)
    const resume = suspendInlineStyles([override])
    expect(element.style.getPropertyValue('color')).toBe('rgb(10, 20, 30)')
    expect(element.style.getPropertyPriority('color')).toBe('important')
    resume()
    expect(override.isApplied()).toBe(true)

    override.restore()
    expect(element.style.getPropertyValue('color')).toBe('rgb(10, 20, 30)')
    expect(element.style.getPropertyPriority('color')).toBe('important')
    expect(element.style.getPropertyValue('background-color')).toBe('white')
  })

  it('removes the transient style attribute when the target had none', () => {
    const element = document.createElement('a')
    const override = applyReversibleInlineStyle(element, 'color', '#4a8eff')
    expect(element.hasAttribute('style')).toBe(true)

    override.restore()
    expect(element.hasAttribute('style')).toBe(false)
  })

  it('does not overwrite a newer external inline declaration', () => {
    const element = document.createElement('span')
    const override = applyReversibleInlineStyle(element, 'color', '#4a8eff')
    element.style.setProperty('color', '#00ff00', 'important')

    override.restore()
    expect(element.style.getPropertyValue('color')).toBe('rgb(0, 255, 0)')
    expect(element.style.getPropertyPriority('color')).toBe('important')
  })

  it('restores stacked overrides in reverse application order', () => {
    document.body.innerHTML = '<p style="color: #123456">Text</p>'
    const element = document.querySelector('p')!
    const first = applyReversibleInlineStyle(
      element,
      'color',
      '#abcdef',
    )
    const second = applyReversibleInlineStyle(
      element,
      'color',
      '#fedcba',
    )

    second.restore()
    expect(element.style.getPropertyValue('color')).toBe('rgb(171, 205, 239)')
    expect(element.style.getPropertyPriority('color')).toBe('important')

    first.restore()
    expect(element.getAttribute('style')).toBe('color: #123456')
  })
})

export type ReversibleInlineStyleOverride = {
  readonly element: Element
  readonly property: string
  readonly value: string
  readonly priority: string
  isApplied: () => boolean
  suspend: () => boolean
  resume: () => boolean
  restore: () => void
}

type InlineStyleSnapshot = {
  value: string
  priority: string
  present: boolean
  styleAttributePresent: boolean
  styleAttribute: string | null
  otherProperties: ReadonlyMap<string, string>
}

function inlineStyle(element: Element): CSSStyleDeclaration {
  const style = (element as Element & { style?: CSSStyleDeclaration }).style
  if (!style) {
    throw new TypeError('Presentation target does not support inline styles')
  }
  return style
}

function capture(
  element: Element,
  style: CSSStyleDeclaration,
  property: string,
): InlineStyleSnapshot {
  const value = style.getPropertyValue(property)
  const priority = style.getPropertyPriority(property)
  const otherProperties = new Map<string, string>()
  for (let index = 0; index < style.length; index += 1) {
    const name = style.item(index)
    if (!name || name === property) continue
    otherProperties.set(
      name,
      `${style.getPropertyValue(name)}\u0000${style.getPropertyPriority(name)}`,
    )
  }
  return {
    value,
    priority,
    present: value !== '' || priority !== '',
    styleAttributePresent: element.hasAttribute('style'),
    styleAttribute: element.getAttribute('style'),
    otherProperties,
  }
}

function otherPropertiesMatch(
  style: CSSStyleDeclaration,
  property: string,
  expected: ReadonlyMap<string, string>,
): boolean {
  const actual = new Map<string, string>()
  for (let index = 0; index < style.length; index += 1) {
    const name = style.item(index)
    if (!name || name === property) continue
    actual.set(
      name,
      `${style.getPropertyValue(name)}\u0000${style.getPropertyPriority(name)}`,
    )
  }
  return (
    actual.size === expected.size &&
    [...expected].every(([name, value]) => actual.get(name) === value)
  )
}

function setProperty(
  style: CSSStyleDeclaration,
  property: string,
  value: string,
  priority: string,
): void {
  style.setProperty(property, value, priority)
  if (style.getPropertyPriority(property) === priority) return

  // jsdom/cssstyle and a few older embedded engines can drop `!important`
  // when a canonical rgb(...) value is restored with setProperty(). Rebuild
  // the current declaration list once, without touching any other property.
  const declarations: string[] = []
  for (let index = 0; index < style.length; index += 1) {
    const name = style.item(index)
    if (!name) continue
    const currentPriority =
      name === property ? priority : style.getPropertyPriority(name)
    declarations.push(
      `${name}: ${style.getPropertyValue(name)}${
        currentPriority ? ` !${currentPriority}` : ''
      };`,
    )
  }
  style.cssText = declarations.join(' ')
}

function matches(
  style: CSSStyleDeclaration,
  property: string,
  snapshot: InlineStyleSnapshot,
): boolean {
  return (
    style.getPropertyValue(property) === snapshot.value &&
    style.getPropertyPriority(property) === snapshot.priority
  )
}

function restoreSnapshot(
  element: Element,
  style: CSSStyleDeclaration,
  property: string,
  snapshot: InlineStyleSnapshot,
): void {
  // Replacing the whole style attribute while another owned property is
  // active can invalidate that property's CSSStyleDeclaration and, in some
  // engines, lose its priority. Exact attribute restoration is safe only for
  // a declaration that originally stood alone.
  if (
    snapshot.otherProperties.size === 0 &&
    otherPropertiesMatch(style, property, snapshot.otherProperties)
  ) {
    if (snapshot.styleAttribute === null) element.removeAttribute('style')
    else element.setAttribute('style', snapshot.styleAttribute)
    // Some DOM implementations serialize a declaration without its CSSOM
    // priority. Preserve the exact attribute only when it also restores the
    // owned property semantically; otherwise fall through to setProperty().
    if (matches(inlineStyle(element), property, snapshot)) return
  }
  const currentStyle = inlineStyle(element)
  if (snapshot.present) {
    setProperty(currentStyle, property, snapshot.value, snapshot.priority)
  } else {
    currentStyle.removeProperty(property)
  }
  if (!snapshot.styleAttributePresent && currentStyle.length === 0) {
    element.removeAttribute('style')
  }
}

/**
 * Apply one renderer-owned declaration at inline `!important` precedence.
 *
 * A stylesheet selector cannot reliably outrank arbitrary publication or host
 * selectors that also use `!important`. The rendered iframe is a projection,
 * so a narrowly scoped inline declaration is the strongest reversible author-
 * origin override available without mutating the publication source tree.
 *
 * Restoration is ownership-aware: if another runtime changes the same inline
 * property after LPE applies it, LPE leaves that newer value untouched.
 */
export function applyReversibleInlineStyle(
  element: Element,
  property: string,
  value: string,
  priority = 'important',
): ReversibleInlineStyleOverride {
  const initialStyle = inlineStyle(element)
  const previous = capture(element, initialStyle, property)
  let state: 'applied' | 'suspended' | 'released' = 'applied'
  setProperty(initialStyle, property, value, priority)
  // CSSOM canonicalizes declarations (for example #aabbcc -> rgb(...)). Own
  // the concrete serialized value rather than the caller's input spelling.
  const applied = capture(element, initialStyle, property)

  const isApplied = (): boolean =>
    state === 'applied' && matches(inlineStyle(element), property, applied)

  return {
    element,
    property,
    value,
    priority,
    isApplied,
    suspend: (): boolean => {
      if (!isApplied()) return false
      const style = inlineStyle(element)
      restoreSnapshot(element, style, property, previous)
      state = 'suspended'
      return true
    },
    resume: (): boolean => {
      const style = inlineStyle(element)
      if (state !== 'suspended' || !matches(style, property, previous)) {
        return false
      }
      setProperty(style, property, value, priority)
      state = 'applied'
      return true
    },
    restore: (): void => {
      if (state === 'released') return
      const style = inlineStyle(element)
      if (state === 'applied' && matches(style, property, applied)) {
        restoreSnapshot(element, style, property, previous)
      }
      state = 'released'
    },
  }
}

/** Temporarily expose Published paint while retaining exact layer ownership. */
export function suspendInlineStyles(
  overrides: readonly ReversibleInlineStyleOverride[],
): () => void {
  const suspended = [...overrides]
    .reverse()
    .filter((override) => override.suspend())
  return () => {
    for (const override of [...suspended].reverse()) override.resume()
  }
}

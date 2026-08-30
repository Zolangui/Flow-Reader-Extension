import type {
  PackagingManifestItem,
  RequestFunction,
  Section,
} from '@flow/epubjs'

const SYNTHETIC_ORIGIN = 'https://lumen.invalid/'
const XLINK_NAMESPACE = 'http://www.w3.org/1999/xlink'
const XML_NAMESPACE = 'http://www.w3.org/XML/1998/namespace'
const IMAGE_ELEMENT_PATTERN = /<(?:[\w.-]+:)?(?:img|image)\b/iu

export type SectionImageReference = {
  schemaVersion: 1
  spineIndex: number
  source: string
  resourceHref?: string
  cfi: string
  alt?: string
  kind: 'html-image' | 'svg-image'
}

export type PublicationImageIndexOptions = {
  sections: readonly Section[]
  assets: readonly PackagingManifestItem[]
  resolvePublicationPath: (href: string) => string
  request: RequestFunction
  signal?: AbortSignal
  onSection?: (
    section: Section,
    images: SectionImageReference[],
    completed: number,
    total: number,
  ) => void
  yieldControl?: () => Promise<void>
  onSectionError?: (section: Section, error: unknown) => void
}

export type PublicationImageResourceResolver = {
  assets: readonly PackagingManifestItem[]
  replacementUrls: readonly string[]
  createUrl: (url: string) => Promise<string>
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return
  throw signal.reason ?? new DOMException('Aborted', 'AbortError')
}

function comparablePublicationPath(value: string): string | undefined {
  if (!value) return undefined
  try {
    const parsed = new URL(value, SYNTHETIC_ORIGIN)
    let pathname = parsed.pathname.replace(/\\/gu, '/').replace(/\/+/gu, '/')
    try {
      pathname = decodeURIComponent(pathname)
    } catch {
      // A malformed percent escape remains comparable in its encoded form.
    }
    return pathname.startsWith('/') ? pathname : `/${pathname}`
  } catch {
    return undefined
  }
}

function resolvedSectionReference(
  sectionPath: string,
  source: string,
  element?: Element,
): string | undefined {
  try {
    let base = new URL(sectionPath, SYNTHETIC_ORIGIN)
    const baseElement = element?.ownerDocument.querySelector('base[href]')
    const authoredDocumentBase = baseElement?.getAttribute('href')?.trim()
    if (authoredDocumentBase) base = new URL(authoredDocumentBase, base)

    const ancestry: Element[] = []
    let ancestor: Element | null | undefined = element
    while (ancestor) {
      ancestry.unshift(ancestor)
      ancestor = ancestor.parentElement
    }
    for (const current of ancestry) {
      const xmlBase =
        current.getAttributeNS(XML_NAMESPACE, 'base')?.trim() ||
        current.getAttribute('xml:base')?.trim()
      if (xmlBase) base = new URL(xmlBase, base)
    }
    const resolved = new URL(source, base)
    // Remote publication resources are not fetched merely to populate a local
    // gallery. Packaged resources and data images remain supported.
    if (resolved.origin !== new URL(SYNTHETIC_ORIGIN).origin) return undefined
    return comparablePublicationPath(resolved.href)
  } catch {
    return undefined
  }
}

function srcsetSources(value: string | null): string[] {
  if (!value) return []
  const sources: string[] = []
  let offset = 0
  while (offset < value.length) {
    while (offset < value.length && /[\s,]/u.test(value[offset]!)) offset += 1
    if (offset >= value.length) break
    const start = offset
    const dataUrl = value.slice(offset, offset + 5).toLowerCase() === 'data:'
    while (
      offset < value.length &&
      !/\s/u.test(value[offset]!) &&
      (dataUrl || value[offset] !== ',')
    ) {
      offset += 1
    }
    const source = value.slice(start, offset)
    if (source) sources.push(source)
    // Descriptors belong to this URL and end at the next candidate comma.
    while (offset < value.length && value[offset] !== ',') offset += 1
    if (value[offset] === ',') offset += 1
  }
  return sources
}

function rawImageSources(element: Element): {
  sources: string[]
  kind: SectionImageReference['kind']
} {
  const localName = element.localName.toLowerCase()
  if (localName === 'img') {
    const sources = [
      element.getAttribute('src')?.trim(),
      ...srcsetSources(element.getAttribute('srcset')),
    ]
    const parent = element.parentElement
    if (parent?.localName.toLowerCase() === 'picture') {
      for (const sourceElement of Array.from(parent.children)) {
        if (sourceElement.localName.toLowerCase() !== 'source') continue
        sources.push(...srcsetSources(sourceElement.getAttribute('srcset')))
      }
    }
    return {
      sources: [
        ...new Set(
          sources.filter((source): source is string => Boolean(source)),
        ),
      ],
      kind: 'html-image',
    }
  }
  return {
    sources: [
      element.getAttribute('href')?.trim() ||
        element.getAttributeNS(XLINK_NAMESPACE, 'href')?.trim() ||
        '',
    ].filter(Boolean),
    kind: 'svg-image',
  }
}

function imageElements(document: Document): Element[] {
  return Array.from(document.getElementsByTagName('*')).filter((element) => {
    const localName = element.localName.toLowerCase()
    return localName === 'img' || localName === 'image'
  })
}

function directDataImage(source: string): boolean {
  return /^data:image\//iu.test(source)
}

export function extractSectionImageReferences(
  section: Pick<Section, 'index' | 'href' | 'cfiFromElement'>,
  document: Document,
  assets: readonly PackagingManifestItem[],
  resolvePublicationPath: (href: string) => string,
): SectionImageReference[] {
  if (section.index === undefined || !section.href) return []
  const sectionPath = resolvePublicationPath(section.href)
  const imageAssets = assets
    .filter((asset) => asset.type.toLowerCase().startsWith('image/'))
    .map((asset) => ({
      asset,
      path: comparablePublicationPath(resolvePublicationPath(asset.href)),
    }))
  const references: SectionImageReference[] = []

  for (const element of imageElements(document)) {
    let cfi: string
    try {
      cfi = section.cfiFromElement(element)
    } catch {
      continue
    }
    const alt =
      element.getAttribute('alt')?.trim() ||
      element.getAttribute('aria-label')?.trim() ||
      undefined
    const { sources, kind } = rawImageSources(element)
    for (const source of sources) {
      if (source.startsWith('#')) continue

      let resourceHref: string | undefined
      if (!directDataImage(source)) {
        const resolved = resolvedSectionReference(sectionPath, source, element)
        resourceHref = imageAssets.find(({ path }) => path === resolved)?.asset
          .href
        if (!resourceHref) continue
      }

      references.push({
        schemaVersion: 1,
        spineIndex: section.index,
        source,
        ...(resourceHref ? { resourceHref } : {}),
        cfi,
        ...(alt ? { alt } : {}),
        kind,
      })
    }
  }

  return references
}

function usableReplacementUrl(value: string | undefined): value is string {
  return Boolean(value && /^(?:blob:|data:|https?:)/iu.test(value))
}

/** Resolve one gallery image without waiting for every font/CSS asset. */
export async function resolvePublicationImageDisplaySource(
  reference: SectionImageReference,
  resources: PublicationImageResourceResolver,
  resolvePublicationPath: (href: string) => string,
): Promise<string | undefined> {
  if (directDataImage(reference.source)) return reference.source
  if (!reference.resourceHref) return undefined

  const index = resources.assets.findIndex(
    (asset) => asset.href === reference.resourceHref,
  )
  if (index < 0) return undefined
  const replacement = resources.replacementUrls[index]
  if (usableReplacementUrl(replacement)) return replacement

  try {
    return await resources.createUrl(
      resolvePublicationPath(reference.resourceHref),
    )
  } catch {
    return undefined
  }
}

/**
 * Build the gallery index without retaining source DOMs on live Sections.
 * Sections are processed sequentially so a large illustrated EPUB cannot
 * recreate the previous all-chapters-in-memory regression.
 */
export async function indexPublicationImages(
  options: PublicationImageIndexOptions,
): Promise<Map<number, SectionImageReference[]>> {
  const result = new Map<number, SectionImageReference[]>()
  const total = options.sections.length
  let completed = 0

  for (const section of options.sections) {
    throwIfAborted(options.signal)
    let images: SectionImageReference[] = []
    try {
      const markup = await section.loadSourceText(
        options.request,
        options.signal,
      )
      throwIfAborted(options.signal)
      if (IMAGE_ELEMENT_PATTERN.test(markup)) {
        const source = await section.loadSource(options.request, options.signal)
        throwIfAborted(options.signal)
        images = extractSectionImageReferences(
          section,
          source,
          options.assets,
          options.resolvePublicationPath,
        )
      }
    } catch (error) {
      if (
        options.signal?.aborted ||
        (error as { name?: string } | undefined)?.name === 'AbortError'
      ) {
        throw error
      }
      options.onSectionError?.(section, error)
    }
    if (section.index !== undefined) result.set(section.index, images)
    completed += 1
    options.onSection?.(section, images, completed, total)
    await options.yieldControl?.()
  }

  throwIfAborted(options.signal)
  return result
}

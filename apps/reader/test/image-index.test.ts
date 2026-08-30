// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'

import {
  extractSectionImageReferences,
  indexPublicationImages,
  resolvePublicationImageDisplaySource,
} from '../src/lib/image-index'

const assets = [
  {
    href: 'Images/vector.svg',
    type: 'image/svg+xml',
    overlay: '',
    properties: [],
    fallback: '',
  },
  {
    href: 'Images/plate 01.jpg',
    type: 'image/jpeg',
    overlay: '',
    properties: [],
    fallback: '',
  },
  {
    href: 'Styles/book.css',
    type: 'text/css',
    overlay: '',
    properties: [],
    fallback: '',
  },
]

const resolvePublicationPath = (href: string) => `/OPS/${href}`

function sourceDocument(): Document {
  return new DOMParser().parseFromString(
    `<!doctype html><html><body>
      <p>Before</p>
      <img src="../Images/plate%2001.jpg?edition=1" alt="Plate one" />
      <img src="data:image/png;base64,AAAA" />
      <img src="https://tracker.invalid/remote.jpg" />
      <svg><image href="../Images/vector.svg" aria-label="Vector plate" /></svg>
    </body></html>`,
    'text/html',
  )
}

describe('publication image index', () => {
  it('maps packaged and inline images without treating arbitrary assets as images', () => {
    const section = {
      index: 3,
      href: 'Text/chapter.xhtml',
      cfiFromElement: vi.fn((element: Element) =>
        element.getAttribute('alt')
          ? 'epubcfi(/6/8!/4/4)'
          : 'epubcfi(/6/8!/4/6)',
      ),
    }

    const images = extractSectionImageReferences(
      section as any,
      sourceDocument(),
      assets,
      resolvePublicationPath,
    )

    expect(images).toEqual([
      expect.objectContaining({
        resourceHref: 'Images/plate 01.jpg',
        cfi: 'epubcfi(/6/8!/4/4)',
        alt: 'Plate one',
      }),
      expect.objectContaining({
        source: 'data:image/png;base64,AAAA',
        cfi: 'epubcfi(/6/8!/4/6)',
      }),
      expect.objectContaining({
        resourceHref: 'Images/vector.svg',
        alt: 'Vector plate',
        kind: 'svg-image',
      }),
    ])
    expect(images[1]).not.toHaveProperty('resourceHref')
  })

  it('loads one source document at a time and publishes section progress', async () => {
    let activeLoads = 0
    let maximumActiveLoads = 0
    const sections = [0, 1].map((index) => ({
      index,
      href: `Text/chapter-${index}.xhtml`,
      cfiFromElement: () => `epubcfi(/6/${index * 2 + 2}!/4/2)`,
      loadSourceText: vi.fn(async () => '<img src="../Images/plate.jpg"/>'),
      loadSource: vi.fn(async () => {
        activeLoads += 1
        maximumActiveLoads = Math.max(maximumActiveLoads, activeLoads)
        await Promise.resolve()
        activeLoads -= 1
        return sourceDocument()
      }),
    }))
    const progress: number[] = []

    const result = await indexPublicationImages({
      sections: sections as any,
      assets,
      resolvePublicationPath,
      request: vi.fn() as any,
      onSection: (_section, _images, completed) => progress.push(completed),
    })

    expect(result.size).toBe(2)
    expect(progress).toEqual([1, 2])
    expect(maximumActiveLoads).toBe(1)
  })

  it('does not parse a source DOM when the markup contains no image element', async () => {
    const loadSource = vi.fn()
    const section = {
      index: 0,
      href: 'Text/text-only.xhtml',
      cfiFromElement: vi.fn(),
      loadSourceText: vi.fn(
        async () => '<html><body><p>Text only</p></body></html>',
      ),
      loadSource,
    }

    const result = await indexPublicationImages({
      sections: [section] as any,
      assets,
      resolvePublicationPath,
      request: vi.fn() as any,
    })

    expect(result.get(0)).toEqual([])
    expect(loadSource).not.toHaveBeenCalled()
  })

  it('indexes packaged responsive image candidates from img and picture', () => {
    const document = new DOMParser().parseFromString(
      `<html><body><picture>
        <source srcset="../Images/vector.svg 1x" />
        <img srcset="../Images/plate%2001.jpg 480w" alt="Responsive" />
      </picture></body></html>`,
      'text/html',
    )
    const section = {
      index: 2,
      href: 'Text/responsive.xhtml',
      cfiFromElement: () => 'epubcfi(/6/6!/4/2)',
    }

    const images = extractSectionImageReferences(
      section as any,
      document,
      assets,
      resolvePublicationPath,
    )

    expect(images.map((image) => image.resourceHref).sort()).toEqual([
      'Images/plate 01.jpg',
      'Images/vector.svg',
    ])
  })

  it('resolves image references through authored XML Base ancestors', () => {
    const document = new DOMParser().parseFromString(
      `<html xmlns="http://www.w3.org/1999/xhtml" xml:base="../">
        <body><figure xml:base="Images/"><img src="plate%2001.jpg" /></figure></body>
      </html>`,
      'application/xhtml+xml',
    )
    const section = {
      index: 2,
      href: 'Text/chapter.xhtml',
      cfiFromElement: () => 'epubcfi(/6/6!/4/2)',
    }

    const images = extractSectionImageReferences(
      section as any,
      document,
      assets,
      resolvePublicationPath,
    )

    expect(images).toEqual([
      expect.objectContaining({ resourceHref: 'Images/plate 01.jpg' }),
    ])
  })

  it('continues after one malformed section instead of blanking the gallery', async () => {
    const error = new Error('broken chapter')
    const onSectionError = vi.fn()
    const broken = {
      index: 0,
      href: 'Text/broken.xhtml',
      loadSourceText: vi.fn(async () => {
        throw error
      }),
    }
    const healthy = {
      index: 1,
      href: 'Text/healthy.xhtml',
      cfiFromElement: () => 'epubcfi(/6/4!/4/2)',
      loadSourceText: vi.fn(async () => '<img src="../Images/vector.svg"/>'),
      loadSource: vi.fn(async () => sourceDocument()),
    }

    const result = await indexPublicationImages({
      sections: [broken, healthy] as any,
      assets,
      resolvePublicationPath,
      request: vi.fn() as any,
      onSectionError,
    })

    expect(result.get(0)).toEqual([])
    expect(result.get(1)?.length).toBeGreaterThan(0)
    expect(onSectionError).toHaveBeenCalledWith(broken, error)
  })

  it('resolves one image independently while the global replacement batch is empty', async () => {
    const createUrl = vi.fn(async () => 'blob:lumen/plate')
    const source = await resolvePublicationImageDisplaySource(
      {
        schemaVersion: 1,
        spineIndex: 1,
        source: '../Images/plate%2001.jpg',
        resourceHref: 'Images/plate 01.jpg',
        cfi: 'epubcfi(/6/4!/4/2)',
        kind: 'html-image',
      },
      { assets, replacementUrls: [], createUrl },
      resolvePublicationPath,
    )

    expect(source).toBe('blob:lumen/plate')
    expect(createUrl).toHaveBeenCalledWith('/OPS/Images/plate 01.jpg')
  })
})

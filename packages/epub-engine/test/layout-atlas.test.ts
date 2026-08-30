import { describe, expect, it } from 'vitest'

import {
  buildLayoutAtlas,
  LAYOUT_ATLAS_VERSION,
  pageSpreadFromProperties,
  planLayoutAtlas,
  SpreadPlanner,
  SECTION_LAYOUT_MEASUREMENT_VERSION,
} from '../src/layout-atlas'
import type {
  LayoutFingerprint,
  SectionLayoutMeasurement,
} from '../src/layout-atlas'

function measurement(
  overrides: Partial<SectionLayoutMeasurement> = {},
): SectionLayoutMeasurement {
  return {
    measurementVersion: SECTION_LAYOUT_MEASUREMENT_VERSION,
    spineIndex: 0,
    resourceHref: 'chapter-0.xhtml',
    linear: true,
    layout: 'reflowable',
    flow: 'paginated',
    leafCount: 1,
    presentationGeometryPlanHashes: [],
    ...overrides,
  }
}

function fingerprint(
  overrides: Partial<LayoutFingerprint> = {},
): LayoutFingerprint {
  return {
    publicationFingerprint: 'book-bytes-v1',
    rendererVersion: 'lumen-engine-v1',
    browserEngine: 'gecko',
    browserEngineVersion: '1',
    viewport: { width: 1200, height: 800, deviceScaleFactor: 1 },
    typographyFingerprint: 'typography-v1',
    resolvedFontFingerprint: 'fonts-v1',
    layoutSettingsFingerprint: 'layout-v1',
    presentationGeometryPipelineFingerprint: '[]',
    spreadSemanticsProfile: 'epub33-rec',
    atlasVersion: LAYOUT_ATLAS_VERSION,
    ...overrides,
  }
}

describe('Layout Atlas', () => {
  it('keeps physical leaves separate from content pages in a two-up reflowable plan', () => {
    const atlas = planLayoutAtlas([measurement({ leafCount: 3 })])

    expect(atlas.totalPageCount).toBe(3)
    expect(atlas.totalLeafCount).toBe(4)
    expect(
      atlas.pages.map((page) => [
        page.pageIndex,
        page.leafIndex,
        page.sectionPageIndex,
      ]),
    ).toEqual([
      [0, 0, 0],
      [1, 1, 1],
      [2, 2, 2],
    ])
    expect(atlas.leaves).toEqual([
      { leafIndex: 0, kind: 'content', slot: 'left', pageIndex: 0 },
      { leafIndex: 1, kind: 'content', slot: 'right', pageIndex: 1 },
      { leafIndex: 2, kind: 'content', slot: 'left', pageIndex: 2 },
      { leafIndex: 3, kind: 'blank', slot: 'right' },
    ])
    expect(atlas.spreads).toEqual([
      { spreadIndex: 0, kind: 'pair', leftLeafIndex: 0, rightLeafIndex: 1 },
      { spreadIndex: 1, kind: 'pair', leftLeafIndex: 2, rightLeafIndex: 3 },
    ])
    expect(atlas.viewports.map((viewport) => viewport.kind)).toEqual([
      'spread',
      'spread',
    ])
    expect(atlas.state).toEqual({
      direction: 'ltr',
      openSlot: null,
      previousLayout: 'reflowable',
      previousViewportMode: 'two-up',
    })
  })

  it('exposes the serializable open slot while measurements arrive incrementally', () => {
    const planner = new SpreadPlanner({ direction: 'ltr' })
    planner.append(
      measurement({
        spineIndex: 3,
        resourceHref: 'one.xhtml',
        sectionBoundaryMode: 'continue',
      }),
    )
    expect(planner.state).toEqual({
      direction: 'ltr',
      openSlot: 'right',
      previousLayout: 'reflowable',
      previousViewportMode: 'two-up',
    })

    planner.append(
      measurement({
        spineIndex: 4,
        resourceHref: 'two.xhtml',
        sectionBoundaryMode: 'continue',
      }),
    )
    expect(planner.state.openSlot).toBeNull()
    expect(planner.finish().viewports[0]).toMatchObject({
      kind: 'spread',
      pageIndexes: [0, 1],
    })
  })

  it('honors a forced right opening in LTR by creating a left blank without inflating page count', () => {
    const atlas = planLayoutAtlas([
      measurement({
        layout: 'pre-paginated',
        pageSpread: 'right',
      }),
    ])

    expect(atlas.totalPageCount).toBe(1)
    expect(atlas.totalLeafCount).toBe(2)
    expect(atlas.spreads).toEqual([
      { spreadIndex: 0, kind: 'pair', leftLeafIndex: 0, rightLeafIndex: 1 },
    ])
    expect(atlas.leaves).toEqual([
      { leafIndex: 0, kind: 'blank', slot: 'left' },
      { leafIndex: 1, kind: 'content', slot: 'right', pageIndex: 0 },
    ])
  })

  it('honors a forced left opening in RTL using physical, not reading-order, sides', () => {
    const atlas = planLayoutAtlas(
      [
        measurement({
          layout: 'pre-paginated',
          pageSpread: 'left',
        }),
      ],
      { direction: 'rtl' },
    )

    expect(atlas.spreads).toEqual([
      { spreadIndex: 0, kind: 'pair', leftLeafIndex: 1, rightLeafIndex: 0 },
    ])
    expect(atlas.leaves).toEqual([
      { leafIndex: 0, kind: 'blank', slot: 'right' },
      { leafIndex: 1, kind: 'content', slot: 'left', pageIndex: 0 },
    ])
  })

  it('flushes an opening before a centered page and gives it a single-page viewport', () => {
    const atlas = planLayoutAtlas([
      measurement({
        spineIndex: 0,
        resourceHref: 'before.xhtml',
        sectionBoundaryMode: 'continue',
      }),
      measurement({
        spineIndex: 1,
        resourceHref: 'center.xhtml',
        pageSpread: 'center',
      }),
    ])

    expect(atlas.leaves).toEqual([
      { leafIndex: 0, kind: 'content', slot: 'left', pageIndex: 0 },
      { leafIndex: 1, kind: 'blank', slot: 'right' },
      { leafIndex: 2, kind: 'content', slot: 'center', pageIndex: 1 },
    ])
    expect(atlas.spreads).toEqual([
      { spreadIndex: 0, kind: 'pair', leftLeafIndex: 0, rightLeafIndex: 1 },
      { spreadIndex: 1, kind: 'center', centerLeafIndex: 2 },
    ])
    expect(atlas.viewports[1]).toEqual({
      viewportIndex: 1,
      kind: 'single-page',
      spreadIndex: 1,
      leafIndexes: [2],
      pageIndexes: [1],
    })
  })

  it('does not pair a reflowable occurrence with a pre-paginated occurrence across a layout transition', () => {
    const atlas = planLayoutAtlas([
      measurement({
        spineIndex: 0,
        resourceHref: 'flow.xhtml',
        sectionBoundaryMode: 'continue',
      }),
      measurement({
        spineIndex: 1,
        resourceHref: 'fixed.xhtml',
        layout: 'pre-paginated',
      }),
    ])

    expect(atlas.transitions).toEqual([
      {
        kind: 'layout-change',
        fromLayout: 'reflowable',
        toLayout: 'pre-paginated',
        spineIndex: 1,
        flushedOpenSpread: true,
      },
    ])
    expect(atlas.viewports.map((viewport) => viewport.pageIndexes)).toEqual([
      [0],
      [1],
    ])
    expect(atlas.totalPageCount).toBe(2)
    expect(atlas.totalLeafCount).toBe(4)
  })

  it('represents roll as a viewport without fabricating page leaves and isolates surrounding layouts', () => {
    const atlas = planLayoutAtlas([
      measurement({
        spineIndex: 0,
        resourceHref: 'one.xhtml',
        sectionBoundaryMode: 'continue',
      }),
      measurement({
        spineIndex: 1,
        resourceHref: 'roll.xhtml',
        flow: 'roll',
        leafCount: 0,
      }),
      measurement({ spineIndex: 2, resourceHref: 'two.xhtml' }),
    ])

    expect(atlas.totalPageCount).toBe(2)
    expect(atlas.totalLeafCount).toBe(4)
    expect(atlas.viewports.map((viewport) => viewport.kind)).toEqual([
      'spread',
      'roll',
      'spread',
    ])
    expect(atlas.paginationMode).toBe('mixed')

    const continuous = planLayoutAtlas([
      measurement({ flow: 'roll', leafCount: 0 }),
    ])
    expect(continuous.paginationMode).toBe('roll')
    expect(continuous.totalPageCount).toBe(0)
    expect(atlas.transitions).toEqual([
      {
        kind: 'roll-boundary',
        fromLayout: 'reflowable',
        toLayout: 'roll',
        spineIndex: 1,
        flushedOpenSpread: true,
      },
      {
        kind: 'roll-boundary',
        fromLayout: 'roll',
        toLayout: 'reflowable',
        spineIndex: 2,
        flushedOpenSpread: false,
      },
    ])
  })

  it('matches the current default manager by closing each reflowable section independently', () => {
    const atlas = planLayoutAtlas([
      measurement({ spineIndex: 0, resourceHref: 'one.xhtml' }),
      measurement({ spineIndex: 1, resourceHref: 'two.xhtml' }),
    ])

    expect(atlas.totalPageCount).toBe(2)
    expect(atlas.totalLeafCount).toBe(4)
    expect(atlas.viewports.map((viewport) => viewport.pageIndexes)).toEqual([
      [0],
      [1],
    ])
    expect(atlas.leaves.map((leaf) => leaf.kind)).toEqual([
      'content',
      'blank',
      'content',
      'blank',
    ])
  })

  it('uses a per-section single-page viewport for vertical writing and flushes a prior two-up opening', () => {
    const atlas = planLayoutAtlas(
      [
        measurement({
          spineIndex: 0,
          resourceHref: 'horizontal.xhtml',
          viewportMode: 'two-up',
          sectionBoundaryMode: 'continue',
        }),
        measurement({
          spineIndex: 1,
          resourceHref: 'vertical.xhtml',
          viewportMode: 'single',
          pageSpread: 'right',
        }),
      ],
      { spreadMode: 'two-up' },
    )

    expect(atlas.transitions).toEqual([
      {
        kind: 'viewport-mode-change',
        fromLayout: 'reflowable',
        toLayout: 'reflowable',
        spineIndex: 1,
        flushedOpenSpread: true,
        fromViewportMode: 'two-up',
        toViewportMode: 'single',
      },
    ])
    expect(atlas.leaves).toEqual([
      { leafIndex: 0, kind: 'content', slot: 'left', pageIndex: 0 },
      { leafIndex: 1, kind: 'blank', slot: 'right' },
      { leafIndex: 2, kind: 'content', slot: 'center', pageIndex: 1 },
    ])
    expect(atlas.viewports.map((viewport) => viewport.kind)).toEqual([
      'spread',
      'single-page',
    ])
    expect(atlas.pages[1]?.pageSpread).toBeUndefined()
    expect(atlas.state.previousViewportMode).toBe('single')
  })

  it('keeps consecutive fixed-layout occurrences eligible to form one true spread', () => {
    const atlas = planLayoutAtlas([
      measurement({
        spineIndex: 1,
        resourceHref: 'left.xhtml',
        layout: 'pre-paginated',
      }),
      measurement({
        spineIndex: 2,
        resourceHref: 'right.xhtml',
        layout: 'pre-paginated',
      }),
    ])

    expect(atlas.totalLeafCount).toBe(2)
    expect(atlas.viewports).toEqual([
      {
        viewportIndex: 0,
        kind: 'spread',
        spreadIndex: 0,
        leafIndexes: [0, 1],
        pageIndexes: [0, 1],
      },
    ])
  })

  it('keeps an unforced first fixed-layout spine item in its own viewport', () => {
    const atlas = planLayoutAtlas([
      measurement({
        spineIndex: 0,
        resourceHref: 'cover.xhtml',
        layout: 'pre-paginated',
      }),
      measurement({
        spineIndex: 1,
        resourceHref: 'page-1.xhtml',
        layout: 'pre-paginated',
      }),
      measurement({
        spineIndex: 2,
        resourceHref: 'page-2.xhtml',
        layout: 'pre-paginated',
      }),
    ])

    expect(atlas.totalPageCount).toBe(3)
    expect(atlas.viewports).toHaveLength(2)
    expect(atlas.viewports[0]).toMatchObject({
      kind: 'single-page',
      pageIndexes: [0],
    })
    expect(atlas.viewports[1]).toMatchObject({
      kind: 'spread',
      pageIndexes: [1, 2],
    })
  })

  it('keeps the first linear fixed-layout item standalone after skipped spine items', () => {
    const atlas = planLayoutAtlas([
      measurement({
        spineIndex: 0,
        resourceHref: 'non-linear.xhtml',
        linear: false,
        layout: 'pre-paginated',
        leafCount: 0,
      }),
      measurement({
        spineIndex: 1,
        resourceHref: 'cover.xhtml',
        layout: 'pre-paginated',
      }),
      measurement({
        spineIndex: 2,
        resourceHref: 'page-2.xhtml',
        layout: 'pre-paginated',
      }),
    ])

    expect(atlas.skippedSpineIndexes).toEqual([0])
    expect(atlas.viewports.map((viewport) => viewport.pageIndexes)).toEqual([
      [0],
      [1],
    ])
  })

  it('uses the selected EPUB profile when deciding whether reflowable page-spread is honored', () => {
    const reflowable = measurement({ pageSpread: 'right' })
    const epub33 = planLayoutAtlas([reflowable], {
      spreadSemanticsProfile: 'epub33-rec',
    })
    const epub34 = planLayoutAtlas([reflowable], {
      spreadSemanticsProfile: 'epub34-crd-20260721',
    })
    const fixedEpub34 = planLayoutAtlas(
      [measurement({ layout: 'pre-paginated', pageSpread: 'right' })],
      { spreadSemanticsProfile: 'epub34-crd-20260721' },
    )

    expect(epub33.leaves).toEqual([
      { leafIndex: 0, kind: 'blank', slot: 'left' },
      { leafIndex: 1, kind: 'content', slot: 'right', pageIndex: 0 },
    ])
    expect(epub34.leaves).toEqual([
      { leafIndex: 0, kind: 'content', slot: 'left', pageIndex: 0 },
      { leafIndex: 1, kind: 'blank', slot: 'right' },
    ])
    expect(fixedEpub34.leaves).toEqual(epub33.leaves)
  })

  it('uses one content viewport per page in single-page mode and never creates synthetic blanks', () => {
    const atlas = planLayoutAtlas(
      [measurement({ leafCount: 2, pageSpread: 'right' })],
      { spreadMode: 'single' },
    )

    expect(atlas.totalPageCount).toBe(2)
    expect(atlas.totalLeafCount).toBe(2)
    expect(atlas.leaves.map((leaf) => leaf.slot)).toEqual(['center', 'center'])
    expect(atlas.viewports.map((viewport) => viewport.kind)).toEqual([
      'single-page',
      'single-page',
    ])
  })

  it('excludes non-linear spine occurrences and preserves profile metadata in the local atlas', () => {
    const nonLinear = measurement({
      spineIndex: 1,
      resourceHref: 'notes.xhtml',
      linear: false,
      leafCount: 0,
    })
    const atlas = buildLayoutAtlas(
      fingerprint({ spreadSemanticsProfile: 'epub34-crd-20260721' }),
      [
        measurement({ spineIndex: 0, resourceHref: 'chapter.xhtml' }),
        nonLinear,
      ],
    )

    expect(atlas.spreadSemanticsProfile).toBe('epub34-crd-20260721')
    expect(atlas.fingerprint.spreadSemanticsProfile).toBe('epub34-crd-20260721')
    expect(atlas.totalPageCount).toBe(1)
    expect(atlas.skippedSpineIndexes).toEqual([1])
    expect(atlas.measurements).toEqual([
      measurement({ spineIndex: 0, resourceHref: 'chapter.xhtml' }),
      nonLinear,
    ])
    expect(atlas.presentationGeometryPlanSet).toEqual([
      { spineIndex: 0, geometryPlanHashes: [] },
      { spineIndex: 1, geometryPlanHashes: [] },
    ])
  })

  it('rejects duplicate or out-of-order spine measurements', () => {
    expect(() =>
      planLayoutAtlas([
        measurement({ spineIndex: 2, resourceHref: 'two.xhtml' }),
        measurement({ spineIndex: 2, resourceHref: 'duplicate.xhtml' }),
      ]),
    ).toThrow(/unique and ordered/)
    expect(() =>
      planLayoutAtlas([
        measurement({ spineIndex: 2, resourceHref: 'two.xhtml' }),
        measurement({ spineIndex: 1, resourceHref: 'one.xhtml' }),
      ]),
    ).toThrow(/unique and ordered/)
  })

  it('rejects impossible fixed-layout measurements', () => {
    expect(() =>
      planLayoutAtlas([
        measurement({
          layout: 'pre-paginated',
          flow: 'paginated',
          leafCount: 2,
        }),
      ]),
    ).toThrow(/exactly one/)
  })

  it('rejects malformed measurements instead of silently accepting a corrupt cache source', () => {
    expect(() =>
      planLayoutAtlas([
        measurement({ resourceHref: { href: 'chapter.xhtml' } as never }),
      ]),
    ).toThrow(/resourceHref/)
    expect(() =>
      planLayoutAtlas([measurement({ linear: false, leafCount: 1 })]),
    ).toThrow(/non-linear/)
  })

  it('rejects unsupported planner profiles and modes at runtime', () => {
    expect(() =>
      planLayoutAtlas([], {
        spreadSemanticsProfile: 'future-profile' as never,
      }),
    ).toThrow(/spread semantics profile/)
    expect(() =>
      planLayoutAtlas([], { direction: 'vertical' as never }),
    ).toThrow(/layout direction/)
    expect(() =>
      planLayoutAtlas([], { spreadMode: 'three-up' as never }),
    ).toThrow(/spread mode/)
  })

  it('aggregates accepted geometry identities in spine order without sharing arrays', () => {
    const firstHash = `sha256:${'1'.repeat(64)}`
    const secondHash = `sha256:${'2'.repeat(64)}`
    const measurements = [
      measurement({
        spineIndex: 2,
        resourceHref: 'two.xhtml',
        presentationGeometryPlanHashes: [firstHash],
      }),
      measurement({
        spineIndex: 5,
        resourceHref: 'five.xhtml',
        presentationGeometryPlanHashes: [secondHash],
      }),
    ]
    const atlas = buildLayoutAtlas(fingerprint(), measurements)

    expect(atlas.presentationGeometryPlanSet).toEqual([
      { spineIndex: 2, geometryPlanHashes: [firstHash] },
      { spineIndex: 5, geometryPlanHashes: [secondHash] },
    ])
    measurements[0]!.presentationGeometryPlanHashes.length = 0
    expect(atlas.measurements[0]!.presentationGeometryPlanHashes).toEqual([
      firstHash,
    ])
    expect(atlas.presentationGeometryPlanSet[0]!.geometryPlanHashes).toEqual([
      firstHash,
    ])
  })

  it('normalizes prefixed and legacy page-spread properties without guessing malformed conflicts', () => {
    expect(pageSpreadFromProperties(['rendition:page-spread-left'])).toBe(
      'left',
    )
    expect(pageSpreadFromProperties(['page-spread-right'])).toBe('right')
    expect(pageSpreadFromProperties(['rendition:page-spread-center'])).toBe(
      'center',
    )
    expect(
      pageSpreadFromProperties([
        'rendition:page-spread-left',
        'page-spread-right',
      ]),
    ).toBeUndefined()
  })

  it('rejects an atlas record whose key uses an unsupported atlas version', () => {
    expect(() =>
      buildLayoutAtlas(fingerprint({ atlasVersion: 999 as never }), []),
    ).toThrow('Unsupported layout atlas version: 999')
  })
})

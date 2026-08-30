import { describe, expect, it } from 'vitest'

import {
  createPaginationLifecycleArtifacts,
  buildLayoutAtlas,
  LAYOUT_ATLAS_VERSION,
  recordPaginationGeometryArtifact,
  SECTION_LAYOUT_MEASUREMENT_VERSION,
} from '@flow/epubjs'

import {
  isUsableLayoutAtlas,
  layoutAtlasMatchesVisiblePaginationArtifacts,
  layoutViewportPagesForPosition,
} from '../src/lib/layout-atlas'

const revision = 'sha256:book-v1'

function atlasFixture() {
  const measurements = [
    {
      measurementVersion: SECTION_LAYOUT_MEASUREMENT_VERSION,
      spineIndex: 0,
      resourceHref: 'chapter.xhtml',
      linear: true,
      layout: 'reflowable' as const,
      flow: 'paginated' as const,
      leafCount: 1,
      viewportMode: 'single' as const,
      presentationGeometryPlanHashes: [],
    },
  ]

  return buildLayoutAtlas(
    {
      publicationFingerprint: revision,
      rendererVersion: 'test-renderer',
      browserEngine: 'gecko',
      browserEngineVersion: '1',
      viewport: { width: 800, height: 600, deviceScaleFactor: 1 },
      typographyFingerprint: '{}',
      resolvedFontFingerprint: '{}',
      layoutSettingsFingerprint: '{}',
      presentationGeometryPipelineFingerprint: '[]',
      spreadSemanticsProfile: 'epub33-rec',
      atlasVersion: LAYOUT_ATLAS_VERSION,
    },
    measurements,
    { spreadMode: 'single' },
  )
}

describe('layout Atlas cache validation', () => {
  it('accepts a complete Atlas for the same publication revision', () => {
    expect(isUsableLayoutAtlas(atlasFixture(), revision)).toBe(true)
  })

  it('rejects a stale publication and inconsistent aggregate counts', () => {
    const stale = atlasFixture()
    expect(isUsableLayoutAtlas(stale, 'sha256:other-book')).toBe(false)

    const incomplete = { ...atlasFixture(), totalPageCount: 99 }
    expect(isUsableLayoutAtlas(incomplete, revision)).toBe(false)
  })

  it('rejects an Atlas produced for different renderer settings', () => {
    const atlas = atlasFixture()
    const expected = {
      ...atlas.fingerprint,
      viewport: { ...atlas.fingerprint.viewport, width: 900 },
    }

    expect(isUsableLayoutAtlas(atlas, revision, expected)).toBe(false)

    const differentGeometryPipeline = {
      ...atlas.fingerprint,
      presentationGeometryPipelineFingerprint: '[["adaptive","v2"]]',
    }
    expect(
      isUsableLayoutAtlas(atlas, revision, differentGeometryPipeline),
    ).toBe(false)
  })

  it('rejects a partial or inconsistent presentation geometry plan set', () => {
    const missing = atlasFixture()
    missing.presentationGeometryPlanSet = []
    expect(isUsableLayoutAtlas(missing, revision)).toBe(false)

    const mismatched = atlasFixture()
    mismatched.presentationGeometryPlanSet[0]!.geometryPlanHashes = [
      `sha256:${'1'.repeat(64)}`,
    ]
    expect(isUsableLayoutAtlas(mismatched, revision)).toBe(false)
  })

  it('rejects broken page-to-leaf cross references', () => {
    const broken = atlasFixture()
    broken.pages[0] = { ...broken.pages[0]!, leafIndex: 42 }

    expect(isUsableLayoutAtlas(broken, revision)).toBe(false)
  })

  it('rejects corrupted companion structures even when pages remain valid', () => {
    const brokenSpread = atlasFixture()
    brokenSpread.spreads[0] = {
      ...brokenSpread.spreads[0]!,
      centerLeafIndex: 42,
    } as typeof brokenSpread.spreads[number]
    expect(isUsableLayoutAtlas(brokenSpread, revision)).toBe(false)

    const brokenViewport = atlasFixture()
    brokenViewport.viewports[0] = {
      ...brokenViewport.viewports[0]!,
      pageIndexes: [99],
    } as typeof brokenViewport.viewports[number]
    expect(isUsableLayoutAtlas(brokenViewport, revision)).toBe(false)

    const brokenMeasurement = atlasFixture()
    brokenMeasurement.measurements[0] = {
      ...brokenMeasurement.measurements[0]!,
      leafCount: 2,
    }
    expect(isUsableLayoutAtlas(brokenMeasurement, revision)).toBe(false)
  })

  it('rejects invalid renderer identity values before rebuilding', () => {
    const invalidViewport = atlasFixture()
    invalidViewport.fingerprint.viewport.width = Number.NaN
    expect(isUsableLayoutAtlas(invalidViewport, revision)).toBe(false)

    const invalidDirection = atlasFixture()
    ;(invalidDirection as { direction: string }).direction = 'sideways'
    expect(isUsableLayoutAtlas(invalidDirection, revision)).toBe(false)
  })

  it('treats a cyclic cached fingerprint as a cache miss instead of throwing', () => {
    const cyclic = atlasFixture()
    const viewport = cyclic.fingerprint
      .viewport as typeof cyclic.fingerprint.viewport & {
      self?: unknown
    }
    viewport.self = viewport

    expect(() =>
      isUsableLayoutAtlas(cyclic, revision, atlasFixture().fingerprint),
    ).not.toThrow()
    expect(
      isUsableLayoutAtlas(cyclic, revision, atlasFixture().fingerprint),
    ).toBe(false)
  })

  it('maps an exact solo page even when its viewport has a synthetic blank', () => {
    const atlas = buildLayoutAtlas(
      atlasFixture().fingerprint,
      [
        {
          measurementVersion: SECTION_LAYOUT_MEASUREMENT_VERSION,
          spineIndex: 0,
          resourceHref: 'chapter.xhtml',
          linear: true,
          layout: 'reflowable',
          flow: 'paginated',
          leafCount: 3,
          viewportMode: 'two-up',
          presentationGeometryPlanHashes: [],
        },
      ],
      { spreadMode: 'two-up' },
    )

    expect(atlas.viewports[1]).toMatchObject({
      pageIndexes: [2],
    })
    expect(
      layoutViewportPagesForPosition({
        atlas,
        spineIndex: 0,
        displayedPage: 3,
        direction: 'ltr',
        directMappingSafe: true,
      }),
    ).toEqual([2])
  })

  it('restores the exact consecutive range for a normal two-page viewport', () => {
    const atlas = buildLayoutAtlas(
      atlasFixture().fingerprint,
      [
        {
          measurementVersion: SECTION_LAYOUT_MEASUREMENT_VERSION,
          spineIndex: 0,
          resourceHref: 'chapter.xhtml',
          linear: true,
          layout: 'reflowable',
          flow: 'paginated',
          leafCount: 4,
          viewportMode: 'two-up',
          presentationGeometryPlanHashes: [],
        },
      ],
      { spreadMode: 'two-up' },
    )

    expect(
      layoutViewportPagesForPosition({
        atlas,
        spineIndex: 0,
        displayedPage: 2,
        direction: 'ltr',
        directMappingSafe: true,
      }),
    ).toEqual([0, 1])
    expect(
      layoutViewportPagesForPosition({
        atlas,
        spineIndex: 0,
        displayedPage: 3,
        direction: 'ltr',
        directMappingSafe: true,
      }),
    ).toEqual([2, 3])
  })

  it('keeps genuinely ambiguous placement and RTL mappings approximate', () => {
    const atlas = atlasFixture()

    expect(
      layoutViewportPagesForPosition({
        atlas,
        spineIndex: 0,
        displayedPage: 1,
        direction: 'rtl',
        directMappingSafe: true,
      }),
    ).toBeUndefined()
    expect(
      layoutViewportPagesForPosition({
        atlas,
        spineIndex: 0,
        displayedPage: 1,
        directMappingSafe: false,
      }),
    ).toBeUndefined()
  })

  it('requires the visible reader to make the same geometry decisions as the detached Atlas', () => {
    const hash = `sha256:${'a'.repeat(64)}`
    const atlas = atlasFixture()
    atlas.measurements[0]!.presentationGeometryPlanHashes = [hash]
    atlas.presentationGeometryPlanSet[0]!.geometryPlanHashes = [hash]
    const artifacts = createPaginationLifecycleArtifacts(['adaptive'])
    recordPaginationGeometryArtifact(artifacts, {
      artifactsVersion: artifacts.artifactsVersion,
      producerId: 'adaptive',
      producerVersion: '1',
      spineIndex: 0,
      status: 'accepted',
      geometryPlanHash: hash,
      geometryAffecting: true,
    })

    expect(
      layoutAtlasMatchesVisiblePaginationArtifacts(atlas, [
        { spineIndex: 0, artifacts },
      ]),
    ).toBe(true)

    const published = createPaginationLifecycleArtifacts(['adaptive'])
    recordPaginationGeometryArtifact(published, {
      artifactsVersion: published.artifactsVersion,
      producerId: 'adaptive',
      producerVersion: '1',
      spineIndex: 0,
      status: 'published',
      geometryAffecting: false,
    })
    expect(
      layoutAtlasMatchesVisiblePaginationArtifacts(atlas, [
        { spineIndex: 0, artifacts: published },
      ]),
    ).toBe(false)
    expect(
      layoutAtlasMatchesVisiblePaginationArtifacts(atlas, [
        {
          spineIndex: 0,
          artifacts: createPaginationLifecycleArtifacts(['adaptive']),
        },
      ]),
    ).toBe(false)
  })
})

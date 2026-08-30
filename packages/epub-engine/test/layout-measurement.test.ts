import { afterEach, describe, expect, it, vi } from 'vitest'

import ePub from '../src/epub'
import {
  LayoutMeasurementIncompleteError,
  LayoutMeasurementSession,
} from '../src/layout-measurement'
import IframeView from '../src/managers/views/iframe'
import {
  createPaginationLifecycleArtifacts,
  PAGINATION_ARTIFACTS_VERSION,
  recordPaginationGeometryArtifact,
} from '../src/pagination-lifecycle'

import { getFixtureUrl } from './helpers'

describe('LayoutMeasurementSession', () => {
  let cleanup: (() => void) | undefined

  afterEach(() => {
    cleanup?.()
    cleanup = undefined
    vi.restoreAllMocks()
  })

  it('rejects a zero-sized host before touching the live book', async () => {
    const book = ePub(getFixtureUrl('/alice/'))
    cleanup = () => book.destroy()
    await book.ready
    const session = new LayoutMeasurementSession({
      book,
      renderer: {
        layout: { layout: 'reflowable', spread: 'none', flow: 'paginated' },
        width: 0,
        height: 600,
      },
    })

    await expect(session.measure()).rejects.toThrow(
      'positive, measurable viewport',
    )
    expect(
      book.spine.spineItems.every((section) => section.document === undefined),
    ).toBe(true)
  })

  it('renders only clone views and clears each one before the next section', async () => {
    const book = ePub(getFixtureUrl('/alice/'))
    cleanup = () => book.destroy()
    await book.ready
    const displayedSections: number[] = []
    vi.spyOn(IframeView.prototype, 'display').mockImplementation(function () {
      displayedSections.push(this.section.index!)
      this.document = document
      this.iframe = document.createElement('iframe')
      this.element.appendChild(this.iframe)
      this.displayed = true
      return Promise.resolve(this)
    })
    vi.spyOn(IframeView.prototype, 'setLayout').mockImplementation(function (
      layout,
    ) {
      this.layout = layout
    })
    vi.spyOn(IframeView.prototype, 'measureContentLeaves').mockReturnValue({
      layout: 'reflowable',
      flow: 'paginated',
      axis: 'horizontal',
      viewportMode: 'single',
      rawExtent: 800,
      leafExtent: 800,
      leafCount: 1,
    })
    const session = new LayoutMeasurementSession({
      book,
      renderer: {
        layout: { layout: 'reflowable', spread: 'none', flow: 'paginated' },
        width: 800,
        height: 600,
      },
    })

    const measurements = await session.measure()

    expect(displayedSections).toEqual(
      book.spine.spineItems
        .filter((section) => section.linear)
        .map((section) => section.index),
    )
    expect(measurements).toHaveLength(book.spine.spineItems.length)
    expect(
      book.spine.spineItems.every((section) => section.document === undefined),
    ).toBe(true)
    expect(document.querySelector('[data-lumen-layout-measurement]')).toBeNull()
  })

  it('releases the hidden iframe immediately when an external run is cancelled', async () => {
    const book = ePub(getFixtureUrl('/alice/'))
    cleanup = () => book.destroy()
    await book.ready
    let displayStarted: (() => void) | undefined
    const displayStartedPromise = new Promise<void>((resolve) => {
      displayStarted = resolve
    })
    vi.spyOn(IframeView.prototype, 'display').mockImplementation(function () {
      this.iframe = document.createElement('iframe')
      this.element.appendChild(this.iframe)
      displayStarted?.()
      return new Promise(() => undefined)
    })
    const session = new LayoutMeasurementSession({
      book,
      renderer: {
        layout: { layout: 'reflowable', spread: 'none', flow: 'paginated' },
        width: 800,
        height: 600,
      },
    })
    const controller = new AbortController()
    const measurement = session.measure({ signal: controller.signal })

    await displayStartedPromise
    controller.abort()

    expect(
      document.querySelector('[data-lumen-layout-measurement] iframe'),
    ).toBeNull()
    await expect(measurement).rejects.toMatchObject({ name: 'AbortError' })
    expect(document.querySelector('[data-lumen-layout-measurement]')).toBeNull()
  })

  it('does not publish a completed atlas when progress aborts on the final section', async () => {
    const book = ePub(getFixtureUrl('/alice/'))
    cleanup = () => book.destroy()
    await book.ready
    vi.spyOn(IframeView.prototype, 'display').mockImplementation(function () {
      this.document = document
      this.iframe = document.createElement('iframe')
      this.element.appendChild(this.iframe)
      this.displayed = true
      return Promise.resolve(this)
    })
    vi.spyOn(IframeView.prototype, 'setLayout').mockImplementation(function (
      layout,
    ) {
      this.layout = layout
    })
    vi.spyOn(IframeView.prototype, 'measureContentLeaves').mockReturnValue({
      layout: 'reflowable',
      flow: 'paginated',
      axis: 'horizontal',
      viewportMode: 'single',
      rawExtent: 800,
      leafExtent: 800,
      leafCount: 1,
    })
    const session = new LayoutMeasurementSession({
      book,
      renderer: {
        layout: { layout: 'reflowable', spread: 'none', flow: 'paginated' },
        width: 800,
        height: 600,
      },
    })
    const controller = new AbortController()

    await expect(
      session.measure({
        signal: controller.signal,
        onProgress: ({ completed, total }) => {
          if (completed === total) controller.abort()
        },
      }),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(document.querySelector('[data-lumen-layout-measurement]')).toBeNull()
  })

  it('rejects an unstable layout instead of publishing a provisional page count', async () => {
    const book = ePub(getFixtureUrl('/alice/'))
    cleanup = () => book.destroy()
    await book.ready
    vi.spyOn(IframeView.prototype, 'display').mockImplementation(function () {
      this.document = document
      this.iframe = document.createElement('iframe')
      this.element.appendChild(this.iframe)
      this.displayed = true
      return Promise.resolve(this)
    })
    vi.spyOn(IframeView.prototype, 'setLayout').mockImplementation(function (
      layout,
    ) {
      this.layout = layout
    })
    let extent = 0
    vi.spyOn(IframeView.prototype, 'measureContentLeaves').mockImplementation(
      () => ({
        layout: 'reflowable',
        flow: 'paginated',
        axis: 'horizontal',
        viewportMode: 'single',
        rawExtent: ++extent,
        leafExtent: 800,
        leafCount: 1,
      }),
    )
    const session = new LayoutMeasurementSession({
      book,
      renderer: {
        layout: { layout: 'reflowable', spread: 'none', flow: 'paginated' },
        width: 800,
        height: 600,
      },
    })

    await expect(session.measure()).rejects.toBeInstanceOf(
      LayoutMeasurementIncompleteError,
    )
    expect(document.querySelector('[data-lumen-layout-measurement]')).toBeNull()
  })

  it('retries only an unsettled section instead of restarting earlier chapters', async () => {
    const book = ePub(getFixtureUrl('/alice/'))
    cleanup = () => book.destroy()
    await book.ready
    const selectedSections = book.spine.spineItems
      .filter((section) => section.linear)
      .slice(0, 2)
    book.spine.spineItems.forEach((section) => {
      section.linear = selectedSections.includes(section)
    })
    const displayedSections: number[] = []
    vi.spyOn(IframeView.prototype, 'display').mockImplementation(function () {
      displayedSections.push(this.section.index!)
      this.document = document
      this.iframe = document.createElement('iframe')
      this.element.appendChild(this.iframe)
      this.displayed = true
      return Promise.resolve(this)
    })
    vi.spyOn(IframeView.prototype, 'setLayout').mockImplementation(function (
      layout,
    ) {
      this.layout = layout
    })
    let reads = 0
    vi.spyOn(IframeView.prototype, 'measureContentLeaves').mockImplementation(
      () => {
        reads += 1
        const rawExtent = reads <= 4 ? reads : 800
        return {
          layout: 'reflowable',
          flow: 'paginated',
          axis: 'horizontal',
          viewportMode: 'single',
          rawExtent,
          leafExtent: 800,
          leafCount: 1,
        }
      },
    )
    const session = new LayoutMeasurementSession({
      book,
      renderer: {
        layout: { layout: 'reflowable', spread: 'none', flow: 'paginated' },
        width: 800,
        height: 600,
      },
    })

    await session.measure()

    expect(
      displayedSections.filter((index) => index === selectedSections[0]!.index),
    ).toHaveLength(2)
    expect(
      displayedSections.filter((index) => index === selectedSections[1]!.index),
    ).toHaveLength(1)
  })

  it('rejects a partial geometry-plan set instead of publishing an exact Atlas', async () => {
    const book = ePub(getFixtureUrl('/alice/'))
    cleanup = () => book.destroy()
    await book.ready
    const selected = book.spine.spineItems.find((section) => section.linear)!
    book.spine.spineItems.forEach((section) => {
      section.linear = section === selected
    })
    vi.spyOn(IframeView.prototype, 'display').mockImplementation(function () {
      this.document = document
      this.iframe = document.createElement('iframe')
      this.element.appendChild(this.iframe)
      this.displayed = true
      return Promise.resolve(this)
    })
    vi.spyOn(IframeView.prototype, 'setLayout').mockImplementation(function (
      layout,
    ) {
      this.layout = layout
    })
    vi.spyOn(IframeView.prototype, 'measureContentLeaves').mockReturnValue({
      layout: 'reflowable',
      flow: 'paginated',
      axis: 'horizontal',
      viewportMode: 'single',
      rawExtent: 800,
      leafExtent: 800,
      leafCount: 1,
    })
    vi.spyOn(
      IframeView.prototype,
      'getPaginationLifecycleArtifacts',
    ).mockReturnValue(createPaginationLifecycleArtifacts(['adaptive']))
    const session = new LayoutMeasurementSession({
      book,
      renderer: {
        layout: { layout: 'reflowable', spread: 'none', flow: 'paginated' },
        width: 800,
        height: 600,
      },
      paginationLifecycle: {
        geometryProducerIds: () => ['adaptive'],
      },
    })

    await expect(session.measure()).rejects.toBeInstanceOf(
      LayoutMeasurementIncompleteError,
    )
  })

  it('carries only admitted geometry-affecting hashes into each measurement', async () => {
    const book = ePub(getFixtureUrl('/alice/'))
    cleanup = () => book.destroy()
    await book.ready
    const selected = book.spine.spineItems.find((section) => section.linear)!
    book.spine.spineItems.forEach((section) => {
      section.linear = section === selected
    })
    vi.spyOn(IframeView.prototype, 'display').mockImplementation(function () {
      this.document = document
      this.iframe = document.createElement('iframe')
      this.element.appendChild(this.iframe)
      this.displayed = true
      return Promise.resolve(this)
    })
    vi.spyOn(IframeView.prototype, 'setLayout').mockImplementation(function (
      layout,
    ) {
      this.layout = layout
    })
    vi.spyOn(IframeView.prototype, 'measureContentLeaves').mockReturnValue({
      layout: 'reflowable',
      flow: 'paginated',
      axis: 'horizontal',
      viewportMode: 'single',
      rawExtent: 800,
      leafExtent: 800,
      leafCount: 1,
    })
    const geometryHash = `sha256:${'1'.repeat(64)}`
    vi.spyOn(
      IframeView.prototype,
      'getPaginationLifecycleArtifacts',
    ).mockImplementation(function () {
      const artifacts = createPaginationLifecycleArtifacts(['adaptive'])
      recordPaginationGeometryArtifact(artifacts, {
        artifactsVersion: PAGINATION_ARTIFACTS_VERSION,
        producerId: 'adaptive',
        producerVersion: '1',
        spineIndex: this.section.index!,
        status: 'accepted',
        geometryPlanHash: geometryHash,
        geometryAffecting: true,
      })
      return artifacts
    })
    const session = new LayoutMeasurementSession({
      book,
      renderer: {
        layout: { layout: 'reflowable', spread: 'none', flow: 'paginated' },
        width: 800,
        height: 600,
      },
      paginationLifecycle: {
        geometryProducerIds: () => ['adaptive'],
      },
    })

    const measurements = await session.measure()

    expect(
      measurements.find(
        (measurement) => measurement.spineIndex === selected.index,
      )?.presentationGeometryPlanHashes,
    ).toEqual([geometryHash])
  })
})

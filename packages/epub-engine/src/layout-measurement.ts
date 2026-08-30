import type Book from './book'
import Layout, { sectionLayoutName } from './layout'
import {
  pageSpreadFromProperties,
  SECTION_LAYOUT_MEASUREMENT_VERSION,
} from './layout-atlas'
import type {
  LayoutDirection,
  SectionLayoutFlow,
  SectionLayoutKind,
  SectionLayoutMeasurement,
} from './layout-atlas'
import DefaultViewManager from './managers/default/index'
import IframeView from './managers/views/iframe'
import {
  acceptedGeometryPlanHashes,
  hasCompletePaginationGeometryArtifacts,
  type PaginationLifecycle,
} from './pagination-lifecycle'
import type Section from './section'
import type { LayoutSettings, RequestFunction } from './types'

/**
 * Version of the DOM measurement runner. Bump this whenever the way a raw
 * section is rendered or settled changes; callers include it in their atlas
 * fingerprint so stale visual measurements cannot be reused.
 */
export const LAYOUT_MEASUREMENT_SESSION_VERSION = 7 as const

export interface LayoutMeasurementRendererSettings {
  /** Effective global layout settings from the visible rendition. */
  layout: LayoutSettings
  /** CSS-pixel dimensions of the visible reading viewport. */
  width: number
  height: number
  /** Reader direction, kept separate because LayoutSettings does not require it. */
  direction?: LayoutDirection
  /** Optional explicit column gap from the visible manager. */
  gap?: number
}

export interface LayoutMeasurementSessionOptions {
  book: Book
  renderer: LayoutMeasurementRendererSettings
  /** Shared visible/measurement lifecycle; presentation semantics must match. */
  paginationLifecycle?: PaginationLifecycle
}

export interface LayoutMeasurementProgress {
  completed: number
  total: number
  measurement: SectionLayoutMeasurement
}

/**
 * The renderer could not prove that a section had settled. Callers must keep
 * the stable canonical estimate instead of publishing a visual total that
 * merely happened to be measured before a font or image finished reflowing.
 */
export class LayoutMeasurementIncompleteError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LayoutMeasurementIncompleteError'
  }
}

export interface LayoutMeasurementRunOptions {
  signal?: AbortSignal
  onProgress?: (progress: LayoutMeasurementProgress) => void
}

function abortError(): DOMException {
  return new DOMException(
    'Layout atlas measurement was cancelled',
    'AbortError',
  )
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError()
}

function normalizeFlow(flow: string | undefined): 'paginated' | 'scrolled' {
  return flow === 'scrolled' ||
    flow === 'scrolled-doc' ||
    flow === 'scrolled-continuous'
    ? 'scrolled'
    : 'paginated'
}

function measurementFlow(flow: string | undefined): SectionLayoutFlow {
  return normalizeFlow(flow) === 'scrolled' ? 'roll' : 'paginated'
}

function layoutKind(
  section: Section,
  fallback: string | undefined,
): SectionLayoutKind {
  return sectionLayoutName(section, fallback) === 'pre-paginated'
    ? 'pre-paginated'
    : 'reflowable'
}

/**
 * Wait for a layout opportunity without trusting rAF to run forever. Hidden
 * extension documents and background browser tabs may throttle it
 * indefinitely, even though the detached measurement iframe is measurable.
 */
function nextFrame(
  ownerWindow: Window | null | undefined,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError())

  return new Promise((resolve, reject) => {
    let settled = false
    let frame: number | undefined
    let fallback: ReturnType<typeof setTimeout> | undefined
    const finish = (): void => {
      if (settled) return
      settled = true
      cleanup()
      resolve()
    }
    const fail = (): void => {
      if (settled) return
      settled = true
      cleanup()
      reject(abortError())
    }
    const cleanup = (): void => {
      clearTimeout(timer)
      if (fallback !== undefined) clearTimeout(fallback)
      if (frame !== undefined && ownerWindow?.cancelAnimationFrame) {
        ownerWindow.cancelAnimationFrame(frame)
      }
      signal?.removeEventListener('abort', fail)
    }
    // The timeout is a correctness fallback, not the primary scheduler. It
    // guarantees progress when the browser suppresses rAF in a hidden tab.
    const timer = setTimeout(finish, 100)
    signal?.addEventListener('abort', fail, { once: true })
    if (ownerWindow?.requestAnimationFrame) {
      frame = ownerWindow.requestAnimationFrame(finish)
    } else {
      // DOM test environments and non-window hosts still receive an async
      // layout checkpoint without paying the full fallback delay.
      fallback = setTimeout(finish, 0)
    }
  })
}

/**
 * Reject a wait as soon as the measurement is cancelled. Some EPUB archive
 * requesters cannot truly abort decompression, so racing their promise is
 * still necessary to let the caller release the hidden iframe immediately.
 */
function abortable<T>(
  promise: PromiseLike<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return Promise.resolve(promise)
  if (signal.aborted) return Promise.reject(abortError())

  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      cleanup()
      reject(abortError())
    }
    const cleanup = (): void => signal.removeEventListener('abort', onAbort)

    signal.addEventListener('abort', onAbort, { once: true })
    Promise.resolve(promise).then(
      (value) => {
        cleanup()
        resolve(value)
      },
      (error: unknown) => {
        cleanup()
        reject(error)
      },
    )
  })
}

function yieldToBrowser(): Promise<void> {
  if (typeof requestIdleCallback === 'function') {
    return new Promise((resolve) => {
      requestIdleCallback(() => resolve(), { timeout: 100 })
    })
  }
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function waitWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal,
  cancelPending?: () => void,
): Promise<boolean> {
  if (signal?.aborted) return Promise.reject(abortError())

  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (completed: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve(completed)
    }
    const fail = (error: unknown): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reject(error)
    }
    const onAbort = (): void => {
      cancelPending?.()
      fail(abortError())
    }
    const timer = setTimeout(() => {
      cancelPending?.()
      finish(false)
    }, timeoutMs)
    signal?.addEventListener('abort', onAbort, { once: true })
    // A failed font/image is settled too: the browser has selected its final
    // fallback/error layout and should not block a measurement forever.
    void promise.then(
      () => finish(true),
      () => finish(true),
    )
  })
}

function decodeImage(image: HTMLImageElement): Promise<void> {
  if (typeof image.decode !== 'function') return Promise.resolve()
  return image.decode().catch(() => undefined)
}

function waitForImage(
  image: HTMLImageElement,
  signal?: AbortSignal,
): Promise<void> {
  // The measurement iframe is deliberately offscreen, so browser lazy-load
  // heuristics may otherwise defer an image forever. This clone is ephemeral;
  // forcing eager only affects this private measurement document.
  image.loading = 'eager'
  image.setAttribute('loading', 'eager')

  if (image.complete) return abortable(decodeImage(image), signal)
  if (signal?.aborted) return Promise.reject(abortError())
  return new Promise<void>((resolve, reject) => {
    let settled = false
    const cleanup = (): void => {
      image.removeEventListener('load', done)
      image.removeEventListener('error', done)
      signal?.removeEventListener('abort', onAbort)
    }
    const done = (): void => {
      if (settled) return
      settled = true
      cleanup()
      void abortable(decodeImage(image), signal).then(resolve, reject)
    }
    const onAbort = (): void => {
      if (settled) return
      settled = true
      cleanup()
      reject(abortError())
    }
    image.addEventListener('load', done, { once: true })
    image.addEventListener('error', done, { once: true })
    signal?.addEventListener('abort', onAbort, { once: true })
    // The resource can settle after the initial `complete` read but before
    // listeners are installed. Browser load events are not replayed, so close
    // that race explicitly instead of waiting for the three-second timeout.
    if (image.complete) done()
  })
}

interface ResourceSettling {
  fontsReady: boolean
  imagesReady: boolean
}

async function waitForFontsAndImages(
  view: IframeView,
  signal?: AbortSignal,
): Promise<ResourceSettling> {
  throwIfAborted(signal)
  const doc = view.document
  const fontSet = (doc as Document & { fonts?: { ready?: Promise<unknown> } })
    .fonts
  const images = Array.from(doc.images || [])
  const imageController = new AbortController()
  const abortImages = (): void => imageController.abort()
  signal?.addEventListener('abort', abortImages, { once: true })
  // Fonts and images are independent resources. Waiting in parallel keeps a
  // problematic section bounded to one timeout window instead of two.
  try {
    const [fontsReady, imagesReady] = await Promise.all([
      fontSet?.ready
        ? waitWithTimeout(fontSet.ready, 3000, signal)
        : Promise.resolve(true),
      images.length
        ? waitWithTimeout(
            Promise.all(
              images.map((image) =>
                waitForImage(image, imageController.signal),
              ),
            ),
            3000,
            signal,
            abortImages,
          )
        : Promise.resolve(true),
    ])
    throwIfAborted(signal)
    return { fontsReady, imagesReady }
  } finally {
    signal?.removeEventListener('abort', abortImages)
    // This is idempotent and removes listeners from any image that did not
    // settle, including the timeout path.
    abortImages()
  }
}

function sameLeafMeasurement(
  left: ReturnType<IframeView['measureContentLeaves']>,
  right: ReturnType<IframeView['measureContentLeaves']>,
): boolean {
  return (
    left.layout === right.layout &&
    left.flow === right.flow &&
    left.axis === right.axis &&
    left.viewportMode === right.viewportMode &&
    left.rawExtent === right.rawExtent &&
    left.leafExtent === right.leafExtent &&
    left.leafCount === right.leafCount
  )
}

/**
 * Measures each spine occurrence in a single offscreen manager without ever
 * rendering the live Section. Every iteration uses `cloneForMeasurement()`;
 * destroying a view can therefore only release the clone's DOM and hooks.
 *
 * The host is attached and visibility-hidden rather than display:none or the
 * legacy Stage.hidden wrapper, both of which collapse to 0×0 and produce a
 * false page count. Only one iframe exists at a time.
 */
export class LayoutMeasurementSession {
  private manager: DefaultViewManager | undefined
  private host: HTMLDivElement | undefined
  private destroyed = false
  private runAbort: AbortController | undefined

  constructor(private readonly options: LayoutMeasurementSessionOptions) {}

  /** Cancel a running measurement and release its detached DOM immediately. */
  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.runAbort?.abort()
    this.runAbort = undefined
    try {
      this.manager?.destroy()
    } finally {
      this.manager = undefined
      this.host?.remove()
      this.host = undefined
    }
  }

  async measure(
    runOptions: LayoutMeasurementRunOptions = {},
  ): Promise<SectionLayoutMeasurement[]> {
    if (this.destroyed) throw abortError()
    if (this.runAbort) {
      throw new Error(
        'A LayoutMeasurementSession can only run one measurement at a time',
      )
    }

    const { width, height } = this.options.renderer
    if (
      !Number.isFinite(width) ||
      width <= 0 ||
      !Number.isFinite(height) ||
      height <= 0
    ) {
      throw new RangeError(
        'Layout measurement requires a positive, measurable viewport',
      )
    }
    if (typeof document === 'undefined' || !document.body) {
      throw new Error(
        'Layout measurement requires an attached browser document',
      )
    }

    const controller = new AbortController()
    this.runAbort = controller
    const onExternalAbort = (): void => {
      controller.abort()
      // `IframeView` owns a separate AbortController. Clear its view now
      // instead of waiting for an archive/request implementation to notice
      // our signal. Destroying the disposable manager also removes its host
      // synchronously; the outer finally is intentionally idempotent.
      this.releaseManager()
    }
    runOptions.signal?.addEventListener('abort', onExternalAbort, {
      once: true,
    })

    try {
      throwIfAborted(runOptions.signal)
      this.createManager()
      const sourceSections = this.options.book.spine.spineItems.slice()
      const measurements: SectionLayoutMeasurement[] = []

      for (let position = 0; position < sourceSections.length; position += 1) {
        throwIfAborted(controller.signal)
        const sourceSection = sourceSections[position]!
        const measurement = sourceSection.linear
          ? await this.measureSectionWithRetry(sourceSection, controller.signal)
          : this.skippedMeasurement(sourceSection)
        measurements.push(measurement)
        runOptions.onProgress?.({
          completed: position + 1,
          total: sourceSections.length,
          measurement,
        })
        throwIfAborted(controller.signal)

        // Let user interaction and a visible reader paint between chapters.
        if (position + 1 < sourceSections.length) {
          await abortable(yieldToBrowser(), controller.signal)
        }
      }

      throwIfAborted(controller.signal)
      return measurements
    } finally {
      runOptions.signal?.removeEventListener('abort', onExternalAbort)
      this.runAbort = undefined
      this.releaseManager()
    }
  }

  private async measureSectionWithRetry(
    sourceSection: Section,
    signal: AbortSignal,
  ): Promise<SectionLayoutMeasurement> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await this.measureSection(sourceSection, signal)
      } catch (error) {
        if (
          !(error instanceof LayoutMeasurementIncompleteError) ||
          attempt === 1
        ) {
          throw error
        }
        // Retry only the unsettled section. Restarting every preceding chapter
        // is expensive and cannot make this section's resources settle sooner.
        await abortable(yieldToBrowser(), signal)
      }
    }

    throw new LayoutMeasurementIncompleteError(
      `Section ${sourceSection.index} did not settle after retry`,
    )
  }

  private createManager(): void {
    if (this.manager || this.host) return
    const { renderer } = this.options
    const direction = renderer.direction ?? 'ltr'
    const host = document.createElement('div')
    host.setAttribute('aria-hidden', 'true')
    host.dataset.lumenLayoutMeasurement = 'true'
    host.style.position = 'fixed'
    host.style.left = '-100000px'
    host.style.top = '0'
    host.style.width = `${renderer.width}px`
    host.style.height = `${renderer.height}px`
    host.style.visibility = 'hidden'
    host.style.pointerEvents = 'none'
    host.style.overflow = 'hidden'
    host.style.contain = 'layout paint style'
    document.body.appendChild(host)
    this.host = host

    const manager = new DefaultViewManager({
      view: IframeView,
      request: this.options.book.load.bind(
        this.options.book,
      ) as RequestFunction,
      settings: {
        width: renderer.width,
        height: renderer.height,
        flow: renderer.layout.flow,
        layout: renderer.layout.layout,
        spread: renderer.layout.spread,
        minSpreadWidth: renderer.layout.minSpreadWidth,
        gap: renderer.gap,
        direction,
        forceEvenPages: false,
        allowScriptedContent: false,
        allowPopups: false,
        paginationLifecycle: this.options.paginationLifecycle,
        paginationPurpose: 'layout-measurement',
      },
    })
    manager.updateFlow(normalizeFlow(renderer.layout.flow))
    manager.direction(direction)
    manager.applyLayout(this.createLayout())
    manager.render(host, { width: renderer.width, height: renderer.height })
    this.manager = manager
  }

  private createLayout(): Layout {
    const { layout } = this.options.renderer
    const instance = new Layout({ ...layout })
    instance.flow(normalizeFlow(layout.flow))
    instance.spread(layout.spread, layout.minSpreadWidth)
    return instance
  }

  private prepareNextSection(): DefaultViewManager {
    const manager = this.manager
    if (!manager || this.destroyed) throw abortError()
    manager.clear()
    manager.updateFlow(normalizeFlow(this.options.renderer.layout.flow))
    manager.direction(this.options.renderer.direction ?? 'ltr')
    manager.applyLayout(this.createLayout())
    return manager
  }

  private skippedMeasurement(section: Section): SectionLayoutMeasurement {
    const { layout } = this.options.renderer
    const effectiveLayout = layoutKind(section, layout.layout)
    return {
      measurementVersion: SECTION_LAYOUT_MEASUREMENT_VERSION,
      spineIndex: section.index!,
      resourceHref: section.href!,
      linear: false,
      layout: effectiveLayout,
      flow:
        effectiveLayout === 'pre-paginated'
          ? 'paginated'
          : measurementFlow(layout.flow),
      leafCount: 0,
      pageSpread: pageSpreadFromProperties(section.properties),
      presentationGeometryPlanHashes: [],
    }
  }

  private async measureSection(
    sourceSection: Section,
    signal: AbortSignal,
  ): Promise<SectionLayoutMeasurement> {
    const manager = this.prepareNextSection()
    const clone = sourceSection.cloneForMeasurement()
    try {
      const view = await abortable(manager.add(clone), signal)
      throwIfAborted(signal)
      // Shared preparePagination hooks have already applied every host style
      // before the view's first format. Settle resources before reading it.
      view.setLayout(manager.layout)
      const resources = await waitForFontsAndImages(view, signal)
      let previous = view.measureContentLeaves()
      let layoutStable = false
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await nextFrame(view.window ?? view.document.defaultView, signal)
        throwIfAborted(signal)
        view.setLayout(manager.layout)
        const current = view.measureContentLeaves()
        if (sameLeafMeasurement(previous, current)) {
          previous = current
          layoutStable = true
          break
        }
        previous = current
      }
      if (!resources.fontsReady || !resources.imagesReady || !layoutStable) {
        const incomplete = [
          !resources.fontsReady ? 'fonts' : undefined,
          !resources.imagesReady ? 'images' : undefined,
          !layoutStable ? 'layout' : undefined,
        ]
          .filter(Boolean)
          .join(', ')
        throw new LayoutMeasurementIncompleteError(
          `Section ${sourceSection.index} did not settle (${incomplete})`,
        )
      }

      const presentationArtifacts = view.getPaginationLifecycleArtifacts()
      if (
        !hasCompletePaginationGeometryArtifacts(presentationArtifacts) ||
        presentationArtifacts.geometry.some(
          (artifact) => artifact.spineIndex !== sourceSection.index,
        )
      ) {
        throw new LayoutMeasurementIncompleteError(
          `Section ${sourceSection.index} has an incomplete presentation geometry plan set`,
        )
      }

      return {
        measurementVersion: SECTION_LAYOUT_MEASUREMENT_VERSION,
        spineIndex: sourceSection.index!,
        resourceHref: sourceSection.href!,
        linear: true,
        layout: previous.layout,
        flow: previous.flow,
        leafCount: previous.leafCount,
        pageSpread: pageSpreadFromProperties(sourceSection.properties),
        sectionBoundaryMode:
          previous.layout === 'reflowable' ? 'flush' : 'continue',
        viewportMode: previous.viewportMode,
        presentationGeometryPlanHashes: acceptedGeometryPlanHashes(
          presentationArtifacts,
        ),
      }
    } finally {
      // Views.destroy() only unloads the clone. Its explicit destroy clears
      // the cloned Hook instances too, without touching the live spine.
      manager.clear()
      clone.destroy()
    }
  }

  private releaseManager(): void {
    try {
      this.manager?.destroy()
    } finally {
      this.manager = undefined
      this.host?.remove()
      this.host = undefined
    }
  }
}

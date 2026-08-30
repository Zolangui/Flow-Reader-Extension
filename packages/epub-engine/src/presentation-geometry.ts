import { canonicalJson, type CanonicalJsonValue } from './canonical-json'
import {
  createPresentationHealthMap,
  MAX_PRESENTATION_HEALTH_ELEMENTS,
  PRESENTATION_HEALTH_MODEL_VERSION,
  type PresentationHealthMap,
  type PresentationHealthObservation,
} from './presentation-health'
import type {
  PresentationFinding,
  PresentationOperationValidators,
  PresentationPatch,
  PresentationPlan,
  ProbeResult,
  ValidationFailure,
  ValidationRecordInput,
} from './presentation-plan'
import { boundedInteger, boundedNumber } from './presentation-options'
import {
  createPresentationRuntimeMarker,
  markPresentationRuntimeNode,
} from './presentation-marker'
import {
  createSourceNodeSignature,
  formatSourceTreePath,
  getSourceTreeRoot,
  resolveSourceTreeAddress,
  SOURCE_TREE_MODEL_VERSION,
  type SourceTreeAddress,
} from './source-tree'

export const WIDE_TABLE_ANALYZER_VERSION = 5 as const
export const CONTAIN_OVERFLOW_OPERATION_VERSION = 2 as const
export const CONTAIN_OVERFLOW_VALIDATOR_VERSION = 2 as const

const LAYER_ATTRIBUTE = 'data-lumen-presentation-layer'
const WRAPPER_ATTRIBUTE = 'data-lumen-overflow-wrapper'
const TARGET_ATTRIBUTE = 'data-lumen-overflow-target'

export type ContainOverflowParameters = {
  schemaVersion: 1
  strategy: 'scroll-inline'
  maximumInlineSize: number
  maximumBlockSize: number
  minimumOverflow: number
}

export type WideTableAnalysisOptions = {
  sourceDocument: Document
  renderedDocument: Document
  spineIndex: number
  pageInlineSize: number
  pageBlockSize: number
  layout: 'reflowable' | 'pre-paginated'
  flow: 'paginated' | 'scrolled'
  axis: string
  writingMode: string
  signal?: AbortSignal
  maxInspectedTables?: number
  maxInspectedElements?: number
  maxCandidates?: number
  minimumOverflow?: number
  healthMap?: PresentationHealthMap
}

export type WideTableAnalysis = {
  findings: PresentationFinding[]
  patches: PresentationPatch[]
  inspectedTables: number
  /** Bounded reason codes for rejected candidates; no authored text leaks. */
  diagnostics: string[]
}

type PreparedTarget = {
  element: Element
  previousMarker: string | null
  marker: string
  parameters: ContainOverflowParameters
  sourceRows: number
  sourceCells: number
}

type AppliedOverflowTarget = PreparedTarget & {
  wrapper: HTMLElement
  originalParent: Node
  originalNextSibling: Node | null
}

export type AppliedOverflowLayer = {
  planHash: string
  document: Document
  style: HTMLStyleElement
  targets: AppliedOverflowTarget[]
  restore: () => void
}

type TargetGeometry = {
  wrapperClientWidth: number
  wrapperScrollWidth: number
  wrapperClientHeight: number
  wrapperScrollHeight: number
  tableWidth: number
  tableHeight: number
}

type OverflowGeometrySnapshot = {
  rootScrollWidth: number
  rootScrollHeight: number
  targets: TargetGeometry[]
}

export type OverflowValidation = {
  input: ValidationRecordInput
  geometry: OverflowGeometrySnapshot
}

const appliedLayers = new WeakMap<Document, AppliedOverflowLayer>()

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException('Aborted', 'AbortError')
  }
}

function isExactObject(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  )
}

export function isContainOverflowParameters(
  value: unknown,
): value is ContainOverflowParameters {
  if (
    !isExactObject(value, [
      'schemaVersion',
      'strategy',
      'maximumInlineSize',
      'maximumBlockSize',
      'minimumOverflow',
    ])
  ) {
    return false
  }
  return (
    value.schemaVersion === 1 &&
    value.strategy === 'scroll-inline' &&
    typeof value.maximumInlineSize === 'number' &&
    Number.isFinite(value.maximumInlineSize) &&
    value.maximumInlineSize > 0 &&
    typeof value.maximumBlockSize === 'number' &&
    Number.isFinite(value.maximumBlockSize) &&
    value.maximumBlockSize > 0 &&
    typeof value.minimumOverflow === 'number' &&
    Number.isFinite(value.minimumOverflow) &&
    value.minimumOverflow >= 1 &&
    value.minimumOverflow <= 128
  )
}

export const CONTAIN_OVERFLOW_OPERATION_VALIDATORS: PresentationOperationValidators =
  {
    'contain-overflow': (parameters, patch) =>
      isContainOverflowParameters(parameters) &&
      patch.operationVersion === CONTAIN_OVERFLOW_OPERATION_VERSION &&
      patch.effects.paint === false &&
      patch.effects.geometry === 'local' &&
      patch.effects.semantics === 'presentation-only',
  }

function normalizedLocalName(element: Element): string {
  return (element.localName || element.tagName).toLowerCase()
}

function roundMetric(value: number): number {
  return Math.round(value * 1000) / 1000
}

function sourceAddress(
  spineIndex: number,
  sourcePath: readonly number[],
): SourceTreeAddress {
  return {
    sourceModelVersion: SOURCE_TREE_MODEL_VERSION,
    spineIndex,
    nodeKind: 'element',
    sourcePath: [...sourcePath],
  }
}

function isScrollableOverflow(value: string): boolean {
  return value === 'auto' || value === 'scroll'
}

function alreadyHasInlineScroller(
  observation: PresentationHealthObservation,
  health: PresentationHealthMap,
): boolean {
  let currentIndex = observation.parentObservationIndex
  while (currentIndex !== undefined) {
    const current = health.observations[currentIndex]
    if (!current) break
    // The source root carries the reader's pagination overflow mechanics. It
    // was deliberately excluded by the original ancestor walk and is not an
    // author-provided local scroller around this table.
    if (current.role === 'root') break
    const { style } = current
    if (
      isScrollableOverflow(style.overflowX) ||
      isScrollableOverflow(style.overflowInline)
    ) {
      return true
    }
    currentIndex = current.parentObservationIndex
  }
  return false
}

function isConservativeTableCandidate(
  observation: PresentationHealthObservation,
  health: PresentationHealthMap,
): boolean {
  const { element: table, style } = observation
  const position = style.position
  return (
    style.display === 'table' &&
    style.float === 'none' &&
    style.visibility === 'visible' &&
    style.contentVisibility !== 'hidden' &&
    (position === 'static' || position === 'relative') &&
    (style.transform || 'none') === 'none' &&
    (style.filter || 'none') === 'none' &&
    style.mixBlendMode === 'normal' &&
    style.clipPath === 'none' &&
    style.maskImage === 'none' &&
    style.webkitMaskImage === 'none' &&
    (style.writingMode || 'horizontal-tb').startsWith('horizontal') &&
    (style.direction || 'ltr') === 'ltr' &&
    !isScrollableOverflow(style.overflowX) &&
    !isScrollableOverflow(style.overflowInline) &&
    style.opacity !== undefined &&
    style.opacity >= 0.999 &&
    !table.parentElement?.closest('table') &&
    !alreadyHasInlineScroller(observation, health)
  )
}

function tableResourcesReady(table: Element): boolean {
  const images = Array.from(table.querySelectorAll('img'))
  if (
    images.some(
      (image) =>
        !image.complete || image.naturalWidth <= 0 || image.naturalHeight <= 0,
    )
  ) {
    return false
  }
  return Array.from(table.querySelectorAll('audio, video')).every(
    (media) => (media as HTMLMediaElement).readyState >= 2,
  )
}

async function waitForDocumentFonts(
  document: Document,
  signal?: AbortSignal,
): Promise<boolean> {
  const fonts = (
    document as Document & {
      fonts?: { status?: string; ready?: Promise<unknown> }
    }
  ).fonts
  if (!fonts?.ready || fonts.status !== 'loading') return true
  throwIfAborted(signal)
  return new Promise<boolean>((resolve, reject) => {
    let settled = false
    const cleanup = (): void => {
      globalThis.clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    const finish = (ready: boolean): void => {
      if (settled) return
      settled = true
      cleanup()
      resolve(ready)
    }
    const onAbort = (): void => {
      if (settled) return
      settled = true
      cleanup()
      reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'))
    }
    const timer = globalThis.setTimeout(() => finish(false), 1000)
    signal?.addEventListener('abort', onAbort, { once: true })
    void fonts.ready.then(
      () => finish(true),
      () => finish(true),
    )
  })
}

/**
 * Post-pagination analyzer for one deliberately narrow class: semantic tables
 * wider than a known horizontal page and lacking an existing inline scroller.
 */
export async function analyzeWideTableOverflow(
  options: WideTableAnalysisOptions,
): Promise<WideTableAnalysis> {
  const { sourceDocument, renderedDocument, spineIndex, signal } = options
  const maxInspectedTables = boundedInteger(
    options.maxInspectedTables,
    32,
    0,
    32,
  )
  const maxInspectedElements = boundedInteger(
    options.maxInspectedElements,
    512,
    0,
    MAX_PRESENTATION_HEALTH_ELEMENTS,
  )
  const maxCandidates = boundedInteger(options.maxCandidates, 4, 0, 16)
  const minimumOverflow = boundedNumber(options.minimumOverflow, 8, 1, 128)
  const view = renderedDocument.defaultView
  if (!view) {
    return {
      findings: [],
      patches: [],
      inspectedTables: 0,
      diagnostics: ['missing-render-view'],
    }
  }
  const contextDiagnostics = [
    options.layout !== 'reflowable' ? 'non-reflowable-layout' : undefined,
    options.flow !== 'paginated' ? 'non-paginated-flow' : undefined,
    options.axis !== 'horizontal' ? 'non-horizontal-axis' : undefined,
    !options.writingMode.startsWith('horizontal')
      ? 'non-horizontal-writing-mode'
      : undefined,
    !Number.isFinite(options.pageInlineSize) || options.pageInlineSize <= 0
      ? 'invalid-page-inline-size'
      : undefined,
    !Number.isFinite(options.pageBlockSize) || options.pageBlockSize <= 0
      ? 'invalid-page-block-size'
      : undefined,
  ].filter((value): value is string => Boolean(value))
  if (contextDiagnostics.length > 0) {
    return {
      findings: [],
      patches: [],
      inspectedTables: 0,
      diagnostics: contextDiagnostics,
    }
  }

  if (!(await waitForDocumentFonts(renderedDocument, signal))) {
    return {
      findings: [],
      patches: [],
      inspectedTables: 0,
      diagnostics: ['font-layout-unsettled'],
    }
  }

  const discoveredTables = Array.from(
    renderedDocument.querySelectorAll('table'),
  )
  const selectedTables = discoveredTables.slice(0, maxInspectedTables)
  const replacedTruncatedHealthPrefix = Boolean(
    options.healthMap?.truncated &&
      selectedTables.some(
        (table) =>
          !options.healthMap!.observations.some(
            (observation) => observation.element === table,
          ),
      ),
  )
  const reusable =
    options.healthMap?.modelVersion === PRESENTATION_HEALTH_MODEL_VERSION &&
    options.healthMap.spineIndex === spineIndex &&
    options.healthMap.renderedDocument === renderedDocument &&
    !options.healthMap.truncated &&
    options.healthMap.observations.every(
      (observation) => observation.element.ownerDocument === renderedDocument,
    ) &&
    selectedTables.every((table) =>
      options.healthMap!.observations.some(
        (observation) => observation.element === table,
      ),
    )
      ? options.healthMap
      : undefined
  const health =
    reusable ??
    createPresentationHealthMap({
      renderedDocument,
      spineIndex,
      signal,
      maxInspectedElements:
        maxInspectedElements === 0
          ? 0
          : Math.max(
              maxInspectedElements,
              Math.min(
                MAX_PRESENTATION_HEALTH_ELEMENTS,
                selectedTables.length * 64 + 1,
              ),
            ),
      focusElements: selectedTables,
    })
  const visits = health.observations
    .filter((observation) => observation.role === 'table')
    .slice(0, Math.max(0, maxInspectedTables))

  const findings: PresentationFinding[] = []
  const patches: PresentationPatch[] = []
  const diagnostics: string[] = []
  if (replacedTruncatedHealthPrefix) {
    diagnostics.push('replaced-truncated-health-prefix')
  }
  if (health.truncated) {
    diagnostics.push('table-evidence-truncated')
  }
  if (discoveredTables.length > selectedTables.length) {
    diagnostics.push('table-discovery-truncated')
  }
  for (const observation of visits) {
    const table = observation.element
    const sourcePath = observation.address.sourcePath
    throwIfAborted(signal)
    if (patches.length >= maxCandidates) break
    const rows = table.querySelectorAll('tr').length
    const cells = table.querySelectorAll('th, td').length
    if (rows < 1 || cells < 2 || !table.textContent?.trim()) {
      diagnostics.push('non-semantic-table')
      continue
    }
    if (!isConservativeTableCandidate(observation, health)) {
      diagnostics.push('unsafe-table-style-or-existing-scroller')
      continue
    }
    if (!tableResourcesReady(table)) {
      diagnostics.push('table-resource-unsettled')
      continue
    }

    const observedInlineSize = Math.max(
      observation.geometry.width,
      observation.geometry.scrollWidth,
    )
    const observedBlockSize = observation.geometry.height
    const overflow = observedInlineSize - options.pageInlineSize
    if (
      !Number.isFinite(observedInlineSize) ||
      observedInlineSize <= 0 ||
      overflow < minimumOverflow
    ) {
      diagnostics.push('table-fits-page')
      continue
    }
    // A horizontal scroller is a fragmentation container. Only wrap a table
    // that can fit on one page vertically; otherwise the repair could trade
    // unreachable columns for unreachable rows.
    if (
      !Number.isFinite(observedBlockSize) ||
      observedBlockSize <= 0 ||
      observedBlockSize > options.pageBlockSize + 1
    ) {
      diagnostics.push('table-exceeds-page-block-size')
      continue
    }

    const address = sourceAddress(spineIndex, sourcePath)
    const sourceNode = resolveSourceTreeAddress(
      sourceDocument,
      address,
      spineIndex,
    )
    if (
      !sourceNode ||
      sourceNode.nodeType !== 1 ||
      normalizedLocalName(sourceNode as Element) !== 'table'
    ) {
      diagnostics.push('source-address-mismatch')
      continue
    }
    const signature = await createSourceNodeSignature(sourceNode)
    throwIfAborted(signal)
    if (!signature) {
      diagnostics.push('source-signature-unavailable')
      continue
    }

    const path = formatSourceTreePath(sourcePath)
    const findingId = `wide-table:${spineIndex}:${path}`
    const patchId = `contain-overflow:${spineIndex}:${path}`
    const target = { source: address, sourceSignature: signature }
    const parameters: ContainOverflowParameters = {
      schemaVersion: 1,
      strategy: 'scroll-inline',
      maximumInlineSize: roundMetric(options.pageInlineSize),
      maximumBlockSize: roundMetric(options.pageBlockSize),
      minimumOverflow: roundMetric(minimumOverflow),
    }
    findings.push({
      id: findingId,
      analyzerId: 'lumen.geometry.wide-table',
      analyzerVersion: WIDE_TABLE_ANALYZER_VERSION,
      kind: 'semantic-table-exceeds-paginated-inline-size',
      confidence: 0.99,
      target,
      evidence: {
        availableInlineSize: parameters.maximumInlineSize,
        observedInlineSize: roundMetric(observedInlineSize),
        observedBlockSize: roundMetric(observedBlockSize),
        overflow: roundMetric(overflow),
        rows,
        cells,
        existingInlineScroller: false,
      },
    })
    patches.push({
      id: patchId,
      operationVersion: CONTAIN_OVERFLOW_OPERATION_VERSION,
      target,
      operation: 'contain-overflow',
      parameters: parameters as unknown as {
        [key: string]: CanonicalJsonValue
      },
      reasonFindingIds: [findingId],
      confidence: 0.99,
      reversible: true,
      idempotent: true,
      effects: {
        paint: false,
        geometry: 'local',
        semantics: 'presentation-only',
      },
      cost: {
        semanticLoss: 0,
        sourceScope: 1,
        geometryImpact: 1,
        changedProperties: 6,
      },
      dependencies: [],
      conflicts: [],
    })
  }

  if (visits.length === 0) diagnostics.push('no-semantic-table-found')
  return {
    findings,
    patches,
    inspectedTables: visits.length,
    diagnostics: diagnostics.slice(0, maxInspectedTables),
  }
}

function appendStyle(document: Document): HTMLStyleElement {
  const style = document.createElementNS(
    'http://www.w3.org/1999/xhtml',
    'style',
  ) as HTMLStyleElement
  markPresentationRuntimeNode(style)
  style.setAttribute(LAYER_ATTRIBUTE, 'geometry-v1')
  ;(document.head ?? document.documentElement).appendChild(style)
  return style
}

/** Apply the reversible scroll container only to verified source targets. */
export async function applyContainOverflowPlan(
  plan: PresentationPlan,
  sourceDocument: Document,
  renderedDocument: Document,
  expectedSpineIndex: number,
  signal?: AbortSignal,
): Promise<AppliedOverflowLayer> {
  const existing = appliedLayers.get(renderedDocument)
  if (existing?.planHash === plan.planHash) return existing
  existing?.restore()
  throwIfAborted(signal)

  const geometryPatches = plan.patches.filter(
    (patch) => patch.operation === 'contain-overflow',
  )
  if (geometryPatches.length === 0) {
    throw new TypeError('Plan does not contain an overflow operation')
  }

  const prepared: PreparedTarget[] = []
  for (const [index, patch] of geometryPatches.entries()) {
    throwIfAborted(signal)
    if (
      patch.operationVersion !== CONTAIN_OVERFLOW_OPERATION_VERSION ||
      patch.effects.paint !== false ||
      patch.effects.geometry !== 'local' ||
      patch.effects.semantics !== 'presentation-only' ||
      !isContainOverflowParameters(patch.parameters)
    ) {
      throw new TypeError('Plan contains an invalid overflow operation')
    }
    const sourceNode = resolveSourceTreeAddress(
      sourceDocument,
      patch.target.source,
      expectedSpineIndex,
    )
    if (
      !sourceNode ||
      sourceNode.nodeType !== 1 ||
      normalizedLocalName(sourceNode as Element) !== 'table'
    ) {
      throw new Error('Overflow source target is stale')
    }
    const signature = await createSourceNodeSignature(sourceNode)
    throwIfAborted(signal)
    if (!signature || signature !== patch.target.sourceSignature) {
      throw new Error('Overflow source signature is stale')
    }
    const renderedNode = resolveSourceTreeAddress(
      renderedDocument,
      patch.target.source,
      expectedSpineIndex,
    )
    if (
      !renderedNode ||
      renderedNode.nodeType !== 1 ||
      normalizedLocalName(renderedNode as Element) !== 'table' ||
      !renderedNode.parentNode
    ) {
      throw new Error('Overflow render target is stale')
    }
    const element = renderedNode as Element
    prepared.push({
      element,
      previousMarker: element.getAttribute(TARGET_ATTRIBUTE),
      marker: `${createPresentationRuntimeMarker(
        renderedDocument,
        'overflow',
        TARGET_ATTRIBUTE,
      )}-${index}`,
      parameters: patch.parameters,
      sourceRows: (sourceNode as Element).querySelectorAll('tr').length,
      sourceCells: (sourceNode as Element).querySelectorAll('th, td').length,
    })
  }

  const targets: AppliedOverflowTarget[] = []
  let style: HTMLStyleElement | undefined
  let restored = false
  const restore = (): void => {
    if (restored) return
    restored = true
    for (const target of [...targets].reverse()) {
      if (target.element.parentNode === target.wrapper) {
        if (target.wrapper.parentNode) {
          target.wrapper.parentNode.insertBefore(target.element, target.wrapper)
        } else {
          const reference =
            target.originalNextSibling?.parentNode === target.originalParent
              ? target.originalNextSibling
              : null
          target.originalParent.insertBefore(target.element, reference)
        }
      }
      target.wrapper.remove()
      if (target.previousMarker === null) {
        target.element.removeAttribute(TARGET_ATTRIBUTE)
      } else {
        target.element.setAttribute(TARGET_ATTRIBUTE, target.previousMarker)
      }
    }
    style?.remove()
    const current = appliedLayers.get(renderedDocument)
    if (current?.restore === restore) {
      appliedLayers.delete(renderedDocument)
    }
  }

  try {
    style = appendStyle(renderedDocument)
    style.textContent = prepared
      .map(
        (target) =>
          `[${WRAPPER_ATTRIBUTE}="${target.marker}"] {` +
          `display: block !important;` +
          `inline-size: 100% !important;` +
          `max-inline-size: ${target.parameters.maximumInlineSize}px !important;` +
          `max-block-size: ${target.parameters.maximumBlockSize}px !important;` +
          `overflow-x: auto !important;` +
          `overflow-y: auto !important;` +
          `break-inside: avoid !important;` +
          `page-break-inside: avoid !important;` +
          `overscroll-behavior-inline: contain;` +
          `}`,
      )
      .join('\n')

    for (const target of prepared) {
      throwIfAborted(signal)
      const originalParent = target.element.parentNode!
      const originalNextSibling = target.element.nextSibling
      const wrapper = renderedDocument.createElementNS(
        'http://www.w3.org/1999/xhtml',
        'div',
      ) as HTMLElement
      markPresentationRuntimeNode(wrapper)
      wrapper.setAttribute(WRAPPER_ATTRIBUTE, target.marker)
      wrapper.setAttribute('tabindex', '0')
      target.element.setAttribute(TARGET_ATTRIBUTE, target.marker)
      originalParent.insertBefore(wrapper, target.element)
      wrapper.appendChild(target.element)
      targets.push({
        ...target,
        wrapper,
        originalParent,
        originalNextSibling,
      })
    }

    const layer: AppliedOverflowLayer = {
      planHash: plan.planHash,
      document: renderedDocument,
      style,
      targets,
      restore,
    }
    appliedLayers.set(renderedDocument, layer)
    return layer
  } catch (error) {
    restore()
    throw error
  }
}

export function restoreGeometryPresentationLayer(document: Document): boolean {
  const layer = appliedLayers.get(document)
  if (!layer) return false
  layer.restore()
  return true
}

function geometrySnapshot(
  layer: AppliedOverflowLayer,
): OverflowGeometrySnapshot {
  const root = getSourceTreeRoot(layer.document)
  return {
    rootScrollWidth: root.scrollWidth,
    rootScrollHeight: root.scrollHeight,
    targets: layer.targets.map(({ element, wrapper }) => {
      const rect = element.getBoundingClientRect()
      return {
        wrapperClientWidth: wrapper.clientWidth,
        wrapperScrollWidth: wrapper.scrollWidth,
        wrapperClientHeight: wrapper.clientHeight,
        wrapperScrollHeight: wrapper.scrollHeight,
        tableWidth: Math.max(rect.width, element.scrollWidth),
        tableHeight: rect.height,
      }
    }),
  }
}

function close(left: number, right: number, epsilon = 0.5): boolean {
  return Math.abs(left - right) <= epsilon
}

function sameGeometry(
  left: OverflowGeometrySnapshot,
  right: OverflowGeometrySnapshot,
): boolean {
  return (
    close(left.rootScrollWidth, right.rootScrollWidth) &&
    close(left.rootScrollHeight, right.rootScrollHeight) &&
    left.targets.length === right.targets.length &&
    left.targets.every((target, index) => {
      const other = right.targets[index]!
      return (
        close(target.wrapperClientWidth, other.wrapperClientWidth) &&
        close(target.wrapperScrollWidth, other.wrapperScrollWidth) &&
        close(target.wrapperClientHeight, other.wrapperClientHeight) &&
        close(target.wrapperScrollHeight, other.wrapperScrollHeight) &&
        close(target.tableWidth, other.tableWidth) &&
        close(target.tableHeight, other.tableHeight)
      )
    })
  )
}

function nextFrame(document: Document, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal)
  const contentView = document.defaultView
  let view = contentView
  try {
    view = contentView?.frameElement?.ownerDocument.defaultView ?? contentView
  } catch {
    // A same-origin owner is an optimization, not a correctness requirement.
  }
  return new Promise((resolve, reject) => {
    let frameId: number | undefined
    let timerId: ReturnType<typeof globalThis.setTimeout> | undefined
    let settled = false
    const onAbort = (): void => {
      if (settled) return
      settled = true
      cleanup()
      reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'))
    }
    const cleanup = (): void => {
      signal?.removeEventListener('abort', onAbort)
      if (frameId !== undefined) view?.cancelAnimationFrame?.(frameId)
      if (timerId !== undefined) globalThis.clearTimeout(timerId)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    const done = (): void => {
      if (settled) return
      settled = true
      cleanup()
      try {
        throwIfAborted(signal)
        resolve()
      } catch (error) {
        reject(error)
      }
    }
    if (view?.requestAnimationFrame) {
      frameId = view.requestAnimationFrame(done)
      timerId = globalThis.setTimeout(done, 100)
    } else timerId = globalThis.setTimeout(done, 0)
  })
}

/** Require two consecutive stable browser layouts after repagination. */
export async function waitForOverflowGeometryStability(
  layer: AppliedOverflowLayer,
  signal?: AbortSignal,
  maxObservations = 8,
): Promise<boolean> {
  const observationLimit = boundedInteger(maxObservations, 8, 0, 32)
  let previous = geometrySnapshot(layer)
  for (let index = 0; index < observationLimit; index += 1) {
    await nextFrame(layer.document, signal)
    const current = geometrySnapshot(layer)
    if (sameGeometry(previous, current)) return true
    previous = current
  }
  return false
}

export function validateContainedOverflowPlan(
  layer: AppliedOverflowLayer,
  geometryStable: boolean,
): OverflowValidation {
  const geometry = geometrySnapshot(layer)
  const view = layer.document.defaultView
  const probes: ProbeResult[] = []
  const failureReasons: ValidationFailure[] = []

  layer.targets.forEach((target, index) => {
    const observed = geometry.targets[index]!
    const overflow = view?.getComputedStyle(target.wrapper).overflowX
    const rows = target.element.querySelectorAll('tr').length
    const cells = target.element.querySelectorAll('th, td').length
    const contained =
      observed.wrapperClientWidth > 0 &&
      observed.wrapperClientWidth <= target.parameters.maximumInlineSize + 1 &&
      observed.wrapperScrollWidth >= observed.wrapperClientWidth &&
      observed.wrapperScrollWidth + 1 >= observed.tableWidth &&
      observed.wrapperClientHeight > 0 &&
      observed.wrapperClientHeight <= target.parameters.maximumBlockSize + 1 &&
      observed.wrapperScrollHeight >= observed.wrapperClientHeight &&
      observed.wrapperScrollHeight + 1 >= observed.tableHeight &&
      (overflow === 'auto' || overflow === 'scroll')
    const semanticsPreserved =
      rows === target.sourceRows && cells === target.sourceCells
    const passed = contained && semanticsPreserved
    probes.push({
      id: `wide-table-containment:${index}`,
      probeVersion: CONTAIN_OVERFLOW_VALIDATOR_VERSION,
      passed,
      confidence: passed ? 0.99 : 1,
      metrics: {
        contained,
        semanticsPreserved,
        overflow: overflow ?? 'unresolved',
        wrapperClientWidth: roundMetric(observed.wrapperClientWidth),
        wrapperScrollWidth: roundMetric(observed.wrapperScrollWidth),
        wrapperClientHeight: roundMetric(observed.wrapperClientHeight),
        wrapperScrollHeight: roundMetric(observed.wrapperScrollHeight),
        tableWidth: roundMetric(observed.tableWidth),
        rows,
        cells,
      },
    })
    if (!contained) {
      failureReasons.push({
        code: 'wide-table-not-contained',
        findingIds: [],
        patchIds: [],
      })
    }
    if (!semanticsPreserved) {
      failureReasons.push({
        code: 'wide-table-semantics-changed',
        findingIds: [],
        patchIds: [],
      })
    }
  })
  if (!geometryStable) {
    failureReasons.push({
      code: 'geometry-did-not-settle',
      findingIds: [],
      patchIds: [],
    })
  }

  const passed =
    layer.targets.length > 0 &&
    geometryStable &&
    probes.every((probe) => probe.passed) &&
    failureReasons.length === 0
  const input: ValidationRecordInput = {
    validatorVersion: CONTAIN_OVERFLOW_VALIDATOR_VERSION,
    passed,
    confidence: passed
      ? Math.min(...probes.map((probe) => probe.confidence))
      : 1,
    probes,
    geometryStable,
    failureReasons,
  }
  canonicalJson(input)
  return { input, geometry }
}

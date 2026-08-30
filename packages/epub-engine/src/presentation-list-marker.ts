import { canonicalJson, type CanonicalJsonValue } from './canonical-json'
import {
  contrastRatio,
  oklchToSrgbGamut,
  parseSrgbColor,
  resolveComputedSrgbColor,
  srgbToHex,
  srgbToOklch,
  type SrgbColor,
} from './presentation-color'
import {
  createPresentationHealthMap,
  MAX_PRESENTATION_HEALTH_ELEMENTS,
  PRESENTATION_HEALTH_MODEL_VERSION,
  type PresentationHealthMap,
  type PresentationHealthObservation,
  type PresentationListMarkerObservation,
} from './presentation-health'
import {
  createPresentationRuntimeMarker,
  markPresentationRuntimeNode,
} from './presentation-marker'
import type {
  PresentationFinding,
  PresentationOperationValidators,
  PresentationPatch,
  PresentationPlan,
  ProbeResult,
  ValidationFailure,
  ValidationRecordInput,
} from './presentation-plan'
import {
  createSourceNodeSignature,
  resolveSourceTreeAddress,
} from './source-tree'

export const LIST_MARKER_ANALYZER_VERSION = 1 as const
export const RESTORE_LIST_MARKER_OPERATION_VERSION = 1 as const
export const LIST_MARKER_VALIDATOR_VERSION = 1 as const

const TARGET_ATTRIBUTE = 'data-lumen-list-marker'
const LAYER_ATTRIBUTE = 'data-lumen-presentation-layer'
const HEX_COLOR = /^#[0-9a-f]{6}$/iu

export type RestoreListMarkerParameters = {
  schemaVersion: 1
  sourceText: string
  targetText: string
  canvas: string
  surfaces: string[]
  minimumTextContrast: number
  observedMarkers: number
}

export type ListMarkerAnalysisOptions = {
  sourceDocument: Document
  renderedDocument: Document
  spineIndex: number
  canvasColor: string
  minimumTextContrast?: number
  preferredTextContrast?: number
  maxCandidates?: number
  healthMap?: PresentationHealthMap
  signal?: AbortSignal
}

export type ListMarkerAnalysis = {
  findings: PresentationFinding[]
  patches: PresentationPatch[]
  inspectedMarkers: number
  candidateGroups: number
  truncatedGroups: number
  diagnostics: string[]
}

type CandidateGroup = {
  root: PresentationHealthObservation
  sourceText: SrgbColor
  markers: PresentationListMarkerObservation[]
}

type AppliedMarker = {
  element: Element
  marker: string
  previousMarker: string | null
}

type AppliedTarget = {
  root: Element
  markers: AppliedMarker[]
  parameters: RestoreListMarkerParameters
}

type GeometrySnapshot = {
  scrollWidth: number
  scrollHeight: number
  targets: { x: number; y: number; width: number; height: number }[]
}

export type AppliedListMarkerLayer = {
  planHash: string
  document: Document
  style: HTMLStyleElement
  targets: AppliedTarget[]
  spineIndex: number
  canvas: string
  restore: () => void
}

const appliedLayers = new WeakMap<Document, AppliedListMarkerLayer>()

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException('Aborted', 'AbortError')
  }
}

function boundedNumber(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, value))
    : fallback
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  return Math.floor(boundedNumber(value, fallback, minimum, maximum))
}

function isExactObject(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const actual = Object.keys(value as Record<string, unknown>).sort()
  const expected = [...keys].sort()
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  )
}

export function isRestoreListMarkerParameters(
  value: unknown,
): value is RestoreListMarkerParameters {
  if (
    !isExactObject(value, [
      'schemaVersion',
      'sourceText',
      'targetText',
      'canvas',
      'surfaces',
      'minimumTextContrast',
      'observedMarkers',
    ])
  ) {
    return false
  }
  return (
    value.schemaVersion === 1 &&
    typeof value.sourceText === 'string' &&
    HEX_COLOR.test(value.sourceText) &&
    typeof value.targetText === 'string' &&
    HEX_COLOR.test(value.targetText) &&
    typeof value.canvas === 'string' &&
    HEX_COLOR.test(value.canvas) &&
    Array.isArray(value.surfaces) &&
    value.surfaces.length > 0 &&
    value.surfaces.every(
      (surface) => typeof surface === 'string' && HEX_COLOR.test(surface),
    ) &&
    new Set(value.surfaces).size === value.surfaces.length &&
    typeof value.minimumTextContrast === 'number' &&
    Number.isFinite(value.minimumTextContrast) &&
    value.minimumTextContrast >= 1 &&
    value.minimumTextContrast <= 21 &&
    Number.isInteger(value.observedMarkers) &&
    (value.observedMarkers as number) > 0
  )
}

export const RESTORE_LIST_MARKER_OPERATION_VALIDATORS: PresentationOperationValidators =
  {
    'restore-list-marker': (parameters, patch) =>
      isRestoreListMarkerParameters(parameters) &&
      patch.operationVersion === RESTORE_LIST_MARKER_OPERATION_VERSION &&
      patch.target.pseudo === 'marker' &&
      patch.effects.paint === true &&
      patch.effects.geometry === 'none' &&
      patch.effects.semantics === 'none',
  }

function readableForeground(
  source: SrgbColor,
  backgrounds: readonly SrgbColor[],
  preferredContrast: number,
): SrgbColor | undefined {
  const sourceLch = srgbToOklch(source)
  const lightnessCandidates = Array.from(
    { length: 101 },
    (_, index) => index / 100,
  ).sort(
    (left, right) =>
      Math.abs(left - sourceLch.l) - Math.abs(right - sourceLch.l),
  )
  for (const lightness of lightnessCandidates) {
    const candidate = oklchToSrgbGamut({
      l: lightness,
      c: sourceLch.c,
      h: sourceLch.h,
    })
    if (
      backgrounds.every(
        (background) =>
          contrastRatio(candidate, background) >= preferredContrast,
      )
    ) {
      return candidate
    }
  }
  return undefined
}

function commonObservedAncestor(
  left: PresentationHealthObservation,
  right: PresentationHealthObservation,
  byElement: WeakMap<Element, PresentationHealthObservation>,
): PresentationHealthObservation {
  const ancestors = new WeakSet<Element>()
  let current: Element | null = left.element
  while (current) {
    ancestors.add(current)
    current = current.parentElement
  }
  current = right.element
  while (current) {
    if (ancestors.has(current)) {
      const observation = byElement.get(current)
      if (observation) return observation
    }
    current = current.parentElement
  }
  return left
}

function reusableHealth(
  options: ListMarkerAnalysisOptions,
  canvas: SrgbColor,
): PresentationHealthMap | undefined {
  const health = options.healthMap
  return health?.modelVersion === PRESENTATION_HEALTH_MODEL_VERSION &&
    health.spineIndex === options.spineIndex &&
    health.renderedDocument === options.renderedDocument &&
    health.canvas &&
    srgbToHex(health.canvas) === srgbToHex(canvas)
    ? health
    : undefined
}

export async function analyzeListMarkerContrast(
  options: ListMarkerAnalysisOptions,
): Promise<ListMarkerAnalysis> {
  const canvas = parseSrgbColor(options.canvasColor)
  if (!canvas || canvas.a < 0.999) {
    return {
      findings: [],
      patches: [],
      inspectedMarkers: 0,
      candidateGroups: 0,
      truncatedGroups: 0,
      diagnostics: ['list-marker-invalid-canvas'],
    }
  }
  const minimumTextContrast = boundedNumber(
    options.minimumTextContrast,
    4.5,
    1,
    21,
  )
  const preferredTextContrast = Math.max(
    minimumTextContrast,
    boundedNumber(options.preferredTextContrast, 7, 1, 21),
  )
  const maxCandidates = boundedInteger(options.maxCandidates, 4, 0, 8)
  const health =
    reusableHealth(options, canvas) ??
    createPresentationHealthMap({
      renderedDocument: options.renderedDocument,
      spineIndex: options.spineIndex,
      canvasColor: canvas,
      signal: options.signal,
      maxInspectedElements: MAX_PRESENTATION_HEALTH_ELEMENTS,
    })
  if (health.truncated) {
    return {
      findings: [],
      patches: [],
      inspectedMarkers: health.listMarkers.length,
      candidateGroups: 0,
      truncatedGroups: 0,
      diagnostics: ['list-marker-health-truncated'],
    }
  }

  const observationsByElement = new WeakMap(
    health.observations.map((observation) => [
      observation.element,
      observation,
    ]),
  )
  const groups = new Map<string, CandidateGroup>()
  for (const marker of health.listMarkers) {
    if (
      marker.paint.kind !== 'known' ||
      marker.paint.contrast >= minimumTextContrast
    ) {
      continue
    }
    const root = observationsByElement.get(marker.element)
    const sourceText = resolveComputedSrgbColor(
      marker.style.color,
      marker.element,
    )
    if (!root || !sourceText || sourceText.a < 0.999) continue
    const key = `${srgbToHex(sourceText)}:${srgbToHex(marker.paint.background)}`
    const group = groups.get(key)
    if (!group) {
      groups.set(key, { root, sourceText, markers: [marker] })
    } else {
      group.root = commonObservedAncestor(
        group.root,
        root,
        observationsByElement,
      )
      group.markers.push(marker)
    }
  }

  const findings: PresentationFinding[] = []
  const patches: PresentationPatch[] = []
  let inspectedGroups = 0
  for (const group of groups.values()) {
    throwIfAborted(options.signal)
    if (patches.length >= maxCandidates) break
    inspectedGroups += 1
    const backgrounds = group.markers.flatMap((marker) =>
      marker.paint.kind === 'known' ? [marker.paint.background] : [],
    )
    const targetContrast =
      srgbToOklch(group.sourceText).c >= 0.08
        ? minimumTextContrast
        : preferredTextContrast
    const targetText = readableForeground(
      group.sourceText,
      backgrounds,
      targetContrast,
    )
    if (!targetText) continue
    const sourceNode = resolveSourceTreeAddress(
      options.sourceDocument,
      group.root.address,
      options.spineIndex,
    )
    if (!sourceNode || sourceNode.nodeType !== 1) continue
    const sourceSignature = await createSourceNodeSignature(sourceNode)
    throwIfAborted(options.signal)
    if (!sourceSignature) continue
    const surfaces = [
      ...new Set(backgrounds.map((background) => srgbToHex(background))),
    ].sort()
    const suffix = `${
      group.root.address.sourcePath.join('.') || 'root'
    }:${srgbToHex(group.sourceText).slice(1)}`
    const findingId = `list-marker:${options.spineIndex}:${suffix}`
    const target = {
      source: group.root.address,
      pseudo: 'marker' as const,
      sourceSignature,
    }
    const parameters: RestoreListMarkerParameters = {
      schemaVersion: 1,
      sourceText: srgbToHex(group.sourceText),
      targetText: srgbToHex(targetText),
      canvas: srgbToHex(canvas),
      surfaces,
      minimumTextContrast,
      observedMarkers: group.markers.length,
    }
    findings.push({
      id: findingId,
      analyzerId: 'lumen.list-marker.contrast',
      analyzerVersion: LIST_MARKER_ANALYZER_VERSION,
      kind: 'list-marker-with-insufficient-contrast',
      confidence: 0.96,
      target,
      evidence: {
        sourceText: parameters.sourceText,
        surfaces,
        sourceContrast: Math.min(
          ...group.markers.flatMap((marker) =>
            marker.paint.kind === 'known' ? [marker.paint.contrast] : [],
          ),
        ),
        targetContrast: Math.min(
          ...backgrounds.map((background) =>
            contrastRatio(targetText, background),
          ),
        ),
        observedMarkers: parameters.observedMarkers,
      },
    })
    patches.push({
      id: `restore-list-marker:${options.spineIndex}:${suffix}`,
      operationVersion: RESTORE_LIST_MARKER_OPERATION_VERSION,
      target,
      operation: 'restore-list-marker',
      parameters: parameters as unknown as {
        [key: string]: CanonicalJsonValue
      },
      reasonFindingIds: [findingId],
      confidence: 0.96,
      reversible: true,
      idempotent: true,
      effects: { paint: true, geometry: 'none', semantics: 'none' },
      cost: {
        semanticLoss: 0,
        sourceScope: 1,
        geometryImpact: 0,
        changedProperties: 1,
      },
      dependencies: [],
      conflicts: [],
    })
  }
  const truncatedGroups = Math.max(0, groups.size - inspectedGroups)
  return {
    findings,
    patches,
    inspectedMarkers: health.listMarkers.length,
    candidateGroups: groups.size,
    truncatedGroups,
    diagnostics: truncatedGroups > 0 ? ['list-marker-groups-truncated'] : [],
  }
}

function geometrySnapshot(
  document: Document,
  targets: readonly AppliedTarget[],
): GeometrySnapshot {
  const root = document.documentElement
  return {
    scrollWidth: root.scrollWidth,
    scrollHeight: root.scrollHeight,
    targets: targets.flatMap((target) =>
      target.markers.map(({ element }) => {
        const rect = element.getBoundingClientRect()
        return {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
        }
      }),
    ),
  }
}

function sameGeometry(
  left: GeometrySnapshot,
  right: GeometrySnapshot,
  epsilon = 0.5,
): boolean {
  const close = (a: number, b: number): boolean => Math.abs(a - b) <= epsilon
  return (
    close(left.scrollWidth, right.scrollWidth) &&
    close(left.scrollHeight, right.scrollHeight) &&
    left.targets.length === right.targets.length &&
    left.targets.every((target, index) => {
      const other = right.targets[index]!
      return (
        close(target.x, other.x) &&
        close(target.y, other.y) &&
        close(target.width, other.width) &&
        close(target.height, other.height)
      )
    })
  )
}

function markerSelector(marker: string): string {
  const attribute = `[${TARGET_ATTRIBUTE}="${marker}"]`
  // Repetition raises specificity without touching author IDs or source DOM.
  // Admission still checks the computed marker, so stronger author rules fail
  // closed instead of being reported as repaired.
  return `${attribute}${attribute}${attribute}${attribute}::marker`
}

export async function applyRestoreListMarkerPlan(
  plan: PresentationPlan,
  sourceDocument: Document,
  renderedDocument: Document,
  expectedSpineIndex: number,
  signal?: AbortSignal,
): Promise<AppliedListMarkerLayer | undefined> {
  restoreListMarkerLayer(renderedDocument)
  const patches = plan.patches.filter(
    (patch) => patch.operation === 'restore-list-marker',
  )
  if (patches.length === 0) return undefined
  const targets: AppliedTarget[] = []
  let style: HTMLStyleElement | undefined
  let restored = false
  const restore = (): void => {
    if (restored) return
    restored = true
    style?.remove()
    for (const target of [...targets].reverse()) {
      for (const marker of [...target.markers].reverse()) {
        if (marker.previousMarker === null) {
          marker.element.removeAttribute(TARGET_ATTRIBUTE)
        } else {
          marker.element.setAttribute(TARGET_ATTRIBUTE, marker.previousMarker)
        }
      }
    }
    if (appliedLayers.get(renderedDocument)?.restore === restore) {
      appliedLayers.delete(renderedDocument)
    }
  }
  try {
    let canvas: string | undefined
    for (const patch of patches) {
      throwIfAborted(signal)
      if (
        patch.operationVersion !== RESTORE_LIST_MARKER_OPERATION_VERSION ||
        patch.target.pseudo !== 'marker' ||
        patch.effects.paint !== true ||
        patch.effects.geometry !== 'none' ||
        patch.effects.semantics !== 'none' ||
        !isRestoreListMarkerParameters(patch.parameters)
      ) {
        throw new TypeError('Unsupported list-marker operation')
      }
      if (canvas === undefined) canvas = patch.parameters.canvas
      else if (canvas !== patch.parameters.canvas) {
        throw new TypeError('List-marker plan mixes rendering canvases')
      }
      const sourceNode = resolveSourceTreeAddress(
        sourceDocument,
        patch.target.source,
        expectedSpineIndex,
      )
      const renderedNode = resolveSourceTreeAddress(
        renderedDocument,
        patch.target.source,
        expectedSpineIndex,
      )
      if (
        !sourceNode ||
        sourceNode.nodeType !== 1 ||
        !renderedNode ||
        renderedNode.nodeType !== 1
      ) {
        throw new Error('List-marker source target is stale')
      }
      const signature = await createSourceNodeSignature(sourceNode)
      throwIfAborted(signal)
      if (!signature || signature !== patch.target.sourceSignature) {
        throw new Error('List-marker source signature is stale')
      }
      targets.push({
        root: renderedNode as Element,
        markers: [],
        parameters: patch.parameters,
      })
    }
    if (!canvas) throw new TypeError('List-marker plan has no canvas')
    const publishedHealth = createPresentationHealthMap({
      renderedDocument,
      spineIndex: expectedSpineIndex,
      canvasColor: canvas,
      signal,
      maxInspectedElements: MAX_PRESENTATION_HEALTH_ELEMENTS,
    })
    if (publishedHealth.truncated) {
      throw new Error('List-marker validation sample is truncated')
    }
    const markerBase = createPresentationRuntimeMarker(
      renderedDocument,
      'list-marker',
      TARGET_ATTRIBUTE,
    )
    const rules: string[] = []
    for (const [targetIndex, target] of targets.entries()) {
      const markers = publishedHealth.listMarkers.filter((marker) => {
        if (
          marker.paint.kind !== 'known' ||
          marker.paint.contrast >= target.parameters.minimumTextContrast ||
          srgbToHex(marker.paint.foreground) !== target.parameters.sourceText ||
          !target.parameters.surfaces.includes(
            srgbToHex(marker.paint.background),
          )
        ) {
          return false
        }
        return (
          marker.element === target.root || target.root.contains(marker.element)
        )
      })
      if (markers.length !== target.parameters.observedMarkers) {
        throw new Error('List-marker render evidence is stale')
      }
      for (const [markerIndex, observation] of markers.entries()) {
        const marker = `${markerBase}-${targetIndex}-${markerIndex}`
        const previousMarker =
          observation.element.getAttribute(TARGET_ATTRIBUTE)
        observation.element.setAttribute(TARGET_ATTRIBUTE, marker)
        target.markers.push({
          element: observation.element,
          marker,
          previousMarker,
        })
        rules.push(
          `${markerSelector(marker)} { color: ${
            target.parameters.targetText
          } !important; }`,
        )
      }
    }
    style = renderedDocument.createElementNS(
      'http://www.w3.org/1999/xhtml',
      'style',
    ) as HTMLStyleElement
    markPresentationRuntimeNode(style)
    style.setAttribute(LAYER_ATTRIBUTE, 'list-marker-v1')
    style.textContent = rules.join('\n')
    ;(renderedDocument.head ?? renderedDocument.documentElement).appendChild(
      style,
    )
    const layer: AppliedListMarkerLayer = {
      planHash: plan.planHash,
      document: renderedDocument,
      style,
      targets,
      spineIndex: expectedSpineIndex,
      canvas,
      restore,
    }
    appliedLayers.set(renderedDocument, layer)
    return layer
  } catch (error) {
    restore()
    throw error
  }
}

export function restoreListMarkerLayer(document: Document): void {
  appliedLayers.get(document)?.restore()
}

export function validateRestoredListMarkers(layer: AppliedListMarkerLayer): {
  input: ValidationRecordInput
} {
  const parent = layer.style.parentNode
  if (!parent) throw new Error('List-marker layer is unavailable')
  const nextSibling = layer.style.nextSibling
  const enabledGeometry = geometrySnapshot(layer.document, layer.targets)
  let publishedGeometry: GeometrySnapshot
  layer.style.remove()
  try {
    publishedGeometry = geometrySnapshot(layer.document, layer.targets)
  } finally {
    parent.insertBefore(layer.style, nextSibling)
  }
  const restoredGeometry = geometrySnapshot(layer.document, layer.targets)
  const geometryStable =
    sameGeometry(enabledGeometry, publishedGeometry) &&
    sameGeometry(enabledGeometry, restoredGeometry)
  const health = createPresentationHealthMap({
    renderedDocument: layer.document,
    spineIndex: layer.spineIndex,
    canvasColor: layer.canvas,
    maxInspectedElements: MAX_PRESENTATION_HEALTH_ELEMENTS,
  })
  const byElement = new WeakMap(
    health.listMarkers.map((marker) => [marker.element, marker]),
  )
  let samples = 0
  let repaired = 0
  for (const target of layer.targets) {
    for (const marker of target.markers) {
      samples += 1
      const observation = byElement.get(marker.element)
      if (
        observation?.paint.kind === 'known' &&
        srgbToHex(observation.paint.foreground) ===
          target.parameters.targetText &&
        observation.paint.contrast >= target.parameters.minimumTextContrast
      ) {
        repaired += 1
      }
    }
  }
  const paintProven = !health.truncated && samples > 0 && repaired === samples
  const passed = paintProven && geometryStable
  const probes: ProbeResult[] = [
    {
      id: 'list-marker-contrast',
      probeVersion: LIST_MARKER_VALIDATOR_VERSION,
      passed: paintProven,
      confidence: paintProven ? 0.96 : 0,
      metrics: {
        samples,
        repaired,
        truncated: health.truncated,
      },
    },
  ]
  const failureReasons: ValidationFailure[] = []
  if (!paintProven) {
    failureReasons.push({
      code: 'list-marker-unresolved',
      findingIds: [],
      patchIds: [],
    })
  }
  if (!geometryStable) {
    failureReasons.push({
      code: 'list-marker-geometry-changed',
      findingIds: [],
      patchIds: [],
    })
  }
  const input: ValidationRecordInput = {
    validatorVersion: LIST_MARKER_VALIDATOR_VERSION,
    passed,
    confidence: passed ? 0.96 : 1,
    probes,
    geometryStable,
    failureReasons,
  }
  canonicalJson(input)
  return { input }
}

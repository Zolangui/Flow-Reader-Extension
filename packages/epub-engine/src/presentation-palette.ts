import { canonicalJson, type CanonicalJsonValue } from './canonical-json'
import {
  contrastRatio,
  parseSrgbColor,
  remapOpaquePaletteForDarkTheme,
  resolveComputedSrgbColor,
  srgbToHex,
  type SrgbColor,
} from './presentation-color'
import {
  createPresentationHealthMap,
  MAX_PRESENTATION_HEALTH_ELEMENTS,
  PRESENTATION_HEALTH_MODEL_VERSION,
  type PresentationHealthMap,
  type PresentationObservedStyle,
} from './presentation-health'
import {
  createPresentationRuntimeMarker,
  markPresentationRuntimeNode,
} from './presentation-marker'
import {
  applyReversibleInlineStyle,
  suspendInlineStyles,
  type ReversibleInlineStyleOverride,
} from './presentation-inline-style'
import {
  createSourceNodeSignature,
  formatSourceTreePath,
  getSourceTreeRoot,
  resolveSourceTreeAddress,
  SOURCE_TREE_MODEL_VERSION,
  type SourceTreeAddress,
} from './source-tree'
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

export const OPAQUE_PALETTE_ANALYZER_VERSION = 2 as const
export const REMAP_PALETTE_OPERATION_VERSION = 2 as const
export const OPAQUE_PALETTE_VALIDATOR_VERSION = 4 as const

const LAYER_ATTRIBUTE = 'data-lumen-presentation-layer'
const TARGET_ATTRIBUTE = 'data-lumen-presentation-target'
const HEX_COLOR = /^#[0-9a-f]{6}$/

export type RemapPaletteParameters = {
  schemaVersion: 1
  sourceSurface: string
  sourceText: string
  targetSurface: string
  targetText: string
  canvas: string
  minimumTextContrast: number
}

export type OpaquePaletteAnalysisOptions = {
  sourceDocument: Document
  renderedDocument: Document
  spineIndex: number
  canvasColor: string
  signal?: AbortSignal
  maxInspectedElements?: number
  maxCandidates?: number
  minimumTextContrast?: number
  healthMap?: PresentationHealthMap
}

export type OpaquePaletteAnalysis = {
  findings: PresentationFinding[]
  patches: PresentationPatch[]
  inspectedElements: number
}

type AppliedTarget = {
  element: Element
  previousMarker: string | null
  marker: string
  parameters: RemapPaletteParameters
  surfaceOverride: ReversibleInlineStyleOverride
  textOverride: ReversibleInlineStyleOverride
}

type PreparedTarget = Omit<AppliedTarget, 'surfaceOverride' | 'textOverride'>

export type AppliedPresentationLayer = {
  planHash: string
  document: Document
  style: HTMLStyleElement
  targets: AppliedTarget[]
  spineIndex: number
  canvas: string
  /** Published paint captured before the owned stylesheet is attached. */
  publishedHealth: PresentationHealthMap
  restore: () => void
}

export type PaletteValidation = {
  input: ValidationRecordInput
  geometryBefore: GeometrySnapshot
  geometryAfter: GeometrySnapshot
}

type GeometrySnapshot = {
  scrollWidth: number
  scrollHeight: number
  targets: Array<{ x: number; y: number; width: number; height: number }>
}

const appliedLayers = new WeakMap<Document, AppliedPresentationLayer>()

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

export function isRemapPaletteParameters(
  value: unknown,
): value is RemapPaletteParameters {
  if (
    !isExactObject(value, [
      'schemaVersion',
      'sourceSurface',
      'sourceText',
      'targetSurface',
      'targetText',
      'canvas',
      'minimumTextContrast',
    ])
  ) {
    return false
  }
  return (
    value.schemaVersion === 1 &&
    typeof value.sourceSurface === 'string' &&
    HEX_COLOR.test(value.sourceSurface) &&
    typeof value.sourceText === 'string' &&
    HEX_COLOR.test(value.sourceText) &&
    typeof value.targetSurface === 'string' &&
    HEX_COLOR.test(value.targetSurface) &&
    typeof value.targetText === 'string' &&
    HEX_COLOR.test(value.targetText) &&
    typeof value.canvas === 'string' &&
    HEX_COLOR.test(value.canvas) &&
    typeof value.minimumTextContrast === 'number' &&
    Number.isFinite(value.minimumTextContrast) &&
    value.minimumTextContrast >= 1 &&
    value.minimumTextContrast <= 21
  )
}

export const REMAP_PALETTE_OPERATION_VALIDATORS: PresentationOperationValidators =
  {
    'remap-palette': (parameters, patch) =>
      isRemapPaletteParameters(parameters) &&
      patch.operationVersion === REMAP_PALETTE_OPERATION_VERSION &&
      patch.effects.paint === true &&
      patch.effects.geometry === 'none' &&
      patch.effects.semantics === 'none',
  }

function isSimpleOpaqueRelationship(style: PresentationObservedStyle): boolean {
  return (
    style.display !== 'none' &&
    style.visibility === 'visible' &&
    style.backgroundImage === 'none' &&
    style.mixBlendMode === 'normal' &&
    style.backgroundBlendMode === 'normal' &&
    style.filter === 'none' &&
    style.opacity !== undefined &&
    style.opacity >= 0.999
  )
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

/**
 * Analyze only direct text on opaque, solid, chromatic surfaces. Everything
 * involving compositing or descendant paint is intentionally preserved.
 */
export async function analyzeOpaquePaletteForDarkTheme(
  options: OpaquePaletteAnalysisOptions,
): Promise<OpaquePaletteAnalysis> {
  const { sourceDocument, renderedDocument, spineIndex, signal } = options
  const maxInspectedElements = boundedInteger(
    options.maxInspectedElements,
    512,
    0,
    2047,
  )
  const maxCandidates = boundedInteger(options.maxCandidates, 16, 0, 16)
  const minimumTextContrast = boundedNumber(
    options.minimumTextContrast,
    4.5,
    1,
    21,
  )
  const canvas = parseSrgbColor(options.canvasColor)
  const view = renderedDocument.defaultView
  if (!canvas || canvas.a < 0.999 || !view) {
    return { findings: [], patches: [], inspectedElements: 0 }
  }

  const reusable =
    options.healthMap?.modelVersion === PRESENTATION_HEALTH_MODEL_VERSION &&
    options.healthMap.spineIndex === spineIndex &&
    options.healthMap.renderedDocument === renderedDocument &&
    options.healthMap.canvas !== undefined &&
    srgbToHex(options.healthMap.canvas) === srgbToHex(canvas) &&
    options.healthMap.observations.every(
      (observation) => observation.element.ownerDocument === renderedDocument,
    )
      ? options.healthMap
      : undefined
  const health =
    reusable ??
    createPresentationHealthMap({
      renderedDocument,
      spineIndex,
      canvasColor: canvas,
      maxInspectedElements: Math.max(0, maxInspectedElements) + 1,
      signal,
    })
  if (health.truncated) {
    return {
      findings: [],
      patches: [],
      inspectedElements: health.inspectedElements,
    }
  }
  const visits = health.observations
    .filter((observation) => observation.address.sourcePath.length > 0)
    .slice(0, Math.max(0, maxInspectedElements))

  const findings: PresentationFinding[] = []
  const patches: PresentationPatch[] = []
  for (const observation of visits) {
    const { element } = observation
    const sourcePath = observation.address.sourcePath
    throwIfAborted(signal)
    if (patches.length >= maxCandidates || !observation.directMeaningfulText) {
      continue
    }

    const { style } = observation
    if (!isSimpleOpaqueRelationship(style)) continue
    if (
      observation.paint.kind !== 'known' ||
      observation.paint.surface.kind !== 'element' ||
      observation.paint.surface.address !== observation.address
    ) {
      continue
    }
    const sourceSurface = resolveComputedSrgbColor(
      style.backgroundColor,
      element,
    )
    const sourceText = resolveComputedSrgbColor(style.color, element)
    if (!sourceSurface || !sourceText) continue
    const remap = remapOpaquePaletteForDarkTheme(
      sourceSurface,
      sourceText,
      canvas,
      { minimumTextContrast },
    )
    if (!remap) continue

    const address = sourceAddress(spineIndex, sourcePath)
    const sourceNode = resolveSourceTreeAddress(
      sourceDocument,
      address,
      spineIndex,
    )
    if (
      !sourceNode ||
      sourceNode.nodeType !== 1 ||
      (sourceNode as Element).localName !== element.localName ||
      (sourceNode as Element).namespaceURI !== element.namespaceURI
    ) {
      continue
    }
    const signature = await createSourceNodeSignature(sourceNode)
    throwIfAborted(signal)
    if (!signature) continue

    const path = formatSourceTreePath(sourcePath)
    const findingId = `opaque-palette:${spineIndex}:${path}`
    const patchId = `remap-palette:${spineIndex}:${path}`
    const target = { source: address, sourceSignature: signature }
    const parameters: RemapPaletteParameters = {
      schemaVersion: 1,
      sourceSurface: srgbToHex(sourceSurface),
      sourceText: srgbToHex(sourceText),
      targetSurface: srgbToHex(remap.surface),
      targetText: srgbToHex(remap.text),
      canvas: srgbToHex(canvas),
      minimumTextContrast,
    }
    findings.push({
      id: findingId,
      analyzerId: 'lumen.opaque-palette.dark',
      analyzerVersion: OPAQUE_PALETTE_ANALYZER_VERSION,
      kind: 'light-chromatic-surface-in-dark-context',
      confidence: 0.98,
      target,
      evidence: {
        sourceSurface: parameters.sourceSurface,
        sourceText: parameters.sourceText,
        canvas: parameters.canvas,
        sourceHue: remap.sourceHue,
        mappedHue: remap.mappedHue,
        targetContrast: remap.contrast,
      },
    })
    patches.push({
      id: patchId,
      operationVersion: REMAP_PALETTE_OPERATION_VERSION,
      target,
      operation: 'remap-palette',
      parameters: parameters as unknown as {
        [key: string]: CanonicalJsonValue
      },
      reasonFindingIds: [findingId],
      confidence: 0.98,
      reversible: true,
      idempotent: true,
      effects: { paint: true, geometry: 'none', semantics: 'none' },
      cost: {
        semanticLoss: 0,
        sourceScope: 1,
        geometryImpact: 0,
        changedProperties: 2,
      },
      dependencies: [],
      conflicts: [],
    })
  }

  return { findings, patches, inspectedElements: visits.length }
}

function appendStyle(document: Document): HTMLStyleElement {
  const style = document.createElementNS(
    'http://www.w3.org/1999/xhtml',
    'style',
  ) as HTMLStyleElement
  markPresentationRuntimeNode(style)
  style.setAttribute(LAYER_ATTRIBUTE, 'palette-v2')
  ;(document.head ?? document.documentElement).appendChild(style)
  return style
}

/** Apply only schema-validated declarations in a dedicated reversible layer. */
export async function applyRemapPalettePlan(
  plan: PresentationPlan,
  sourceDocument: Document,
  renderedDocument: Document,
  expectedSpineIndex: number,
  signal?: AbortSignal,
): Promise<AppliedPresentationLayer> {
  const existing = appliedLayers.get(renderedDocument)
  if (existing?.planHash === plan.planHash) return existing
  existing?.restore()
  throwIfAborted(signal)

  const targets: AppliedTarget[] = []
  const preparedTargets: PreparedTarget[] = []
  let style: HTMLStyleElement | undefined
  let restored = false
  const restore = (): void => {
    if (restored) return
    restored = true
    style?.remove()
    for (const target of [...targets].reverse()) {
      target.textOverride.restore()
      target.surfaceOverride.restore()
    }
    for (const target of [...preparedTargets].reverse()) {
      if (target.previousMarker === null) {
        target.element.removeAttribute(TARGET_ATTRIBUTE)
      } else {
        target.element.setAttribute(TARGET_ATTRIBUTE, target.previousMarker)
      }
    }
    const current = appliedLayers.get(renderedDocument)
    if (current?.restore === restore) {
      appliedLayers.delete(renderedDocument)
    }
  }

  try {
    const palettePatches = plan.patches.filter(
      (patch) => patch.operation === 'remap-palette',
    )
    if (palettePatches.length === 0) {
      throw new TypeError('Plan does not contain a palette operation')
    }
    let canvas: string | undefined
    for (const [index, patch] of palettePatches.entries()) {
      throwIfAborted(signal)
      if (
        patch.operationVersion !== REMAP_PALETTE_OPERATION_VERSION ||
        patch.effects.paint !== true ||
        patch.effects.geometry !== 'none' ||
        patch.effects.semantics !== 'none' ||
        !isRemapPaletteParameters(patch.parameters)
      ) {
        throw new TypeError('Plan contains an unsupported palette operation')
      }
      if (canvas === undefined) canvas = patch.parameters.canvas
      else if (patch.parameters.canvas !== canvas) {
        throw new TypeError('Palette plan mixes rendering canvases')
      }
      const sourceNode = resolveSourceTreeAddress(
        sourceDocument,
        patch.target.source,
        expectedSpineIndex,
      )
      if (!sourceNode || sourceNode.nodeType !== 1) {
        throw new Error('Presentation source target is stale')
      }
      const signature = await createSourceNodeSignature(sourceNode)
      throwIfAborted(signal)
      if (!signature || signature !== patch.target.sourceSignature) {
        throw new Error('Presentation source signature is stale')
      }
      const renderedNode = resolveSourceTreeAddress(
        renderedDocument,
        patch.target.source,
        expectedSpineIndex,
      )
      if (!renderedNode || renderedNode.nodeType !== 1) {
        throw new Error('Presentation render target is stale')
      }

      const element = renderedNode as Element
      const marker = `${createPresentationRuntimeMarker(
        renderedDocument,
        'palette',
        TARGET_ATTRIBUTE,
      )}-${index}`
      const previousMarker = element.getAttribute(TARGET_ATTRIBUTE)
      element.setAttribute(TARGET_ATTRIBUTE, marker)
      preparedTargets.push({
        element,
        previousMarker,
        marker,
        parameters: patch.parameters,
      })
    }
    if (!canvas) throw new TypeError('Palette plan has no canvas')

    const publishedHealth = createPresentationHealthMap({
      renderedDocument,
      spineIndex: expectedSpineIndex,
      canvasColor: canvas,
      signal,
      maxInspectedElements: MAX_PRESENTATION_HEALTH_ELEMENTS,
    })
    style = appendStyle(renderedDocument)
    for (const target of preparedTargets) {
      const surfaceOverride = applyReversibleInlineStyle(
        target.element,
        'background-color',
        target.parameters.targetSurface,
      )
      try {
        targets.push({
          ...target,
          surfaceOverride,
          textOverride: applyReversibleInlineStyle(
            target.element,
            'color',
            target.parameters.targetText,
          ),
        })
      } catch (error) {
        surfaceOverride.restore()
        throw error
      }
    }
    const layer: AppliedPresentationLayer = {
      planHash: plan.planHash,
      document: renderedDocument,
      style,
      targets,
      spineIndex: expectedSpineIndex,
      canvas,
      publishedHealth,
      restore,
    }
    appliedLayers.set(renderedDocument, layer)
    return layer
  } catch (error) {
    restore()
    throw error
  }
}

export function restorePresentationLayer(document: Document): void {
  appliedLayers.get(document)?.restore()
}

function geometrySnapshot(layer: AppliedPresentationLayer): GeometrySnapshot {
  const root = getSourceTreeRoot(layer.document)
  return {
    scrollWidth: root.scrollWidth,
    scrollHeight: root.scrollHeight,
    targets: layer.targets.map(({ element }) => {
      const rect = element.getBoundingClientRect()
      return {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      }
    }),
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

function sameRgb(
  left: SrgbColor,
  right: SrgbColor,
  epsilon = 1 / 255,
): boolean {
  return (
    Math.abs(left.r - right.r) <= epsilon &&
    Math.abs(left.g - right.g) <= epsilon &&
    Math.abs(left.b - right.b) <= epsilon &&
    Math.abs(left.a - right.a) <= epsilon
  )
}

/** Toggle only the owned paint layer to prove that it did not move geometry. */
export function validateAppliedPalettePlan(
  layer: AppliedPresentationLayer,
): PaletteValidation {
  if (!layer.style.isConnected) {
    throw new Error('Presentation layer marker is unavailable')
  }
  const enabled = geometrySnapshot(layer)
  let withoutLayer: GeometrySnapshot
  const resume = suspendInlineStyles(
    layer.targets.flatMap((target) => [
      target.surfaceOverride,
      target.textOverride,
    ]),
  )
  try {
    withoutLayer = geometrySnapshot(layer)
  } finally {
    resume()
  }
  const restored = geometrySnapshot(layer)
  const geometryStable =
    sameGeometry(enabled, withoutLayer) && sameGeometry(enabled, restored)

  const health = createPresentationHealthMap({
    renderedDocument: layer.document,
    spineIndex: layer.spineIndex,
    canvasColor: layer.canvas,
    maxInspectedElements: MAX_PRESENTATION_HEALTH_ELEMENTS,
  })
  const byElement = new WeakMap(
    health.observations.map((observation) => [
      observation.element,
      observation,
    ]),
  )
  const publishedByElement = new WeakMap(
    layer.publishedHealth.observations.map((observation) => [
      observation.element,
      observation,
    ]),
  )
  const probes: ProbeResult[] = []
  const failureReasons: ValidationFailure[] = []
  for (const [index, target] of layer.targets.entries()) {
    const observation = byElement.get(target.element)
    const knownPaint =
      !health.truncated &&
      observation?.paint.kind === 'known' &&
      observation.paint.surface.kind === 'element' &&
      health.observations[observation.paint.surface.observationIndex]
        ?.element === target.element
    const surface =
      knownPaint && observation?.paint.kind === 'known'
        ? observation.paint.background
        : undefined
    const text =
      knownPaint && observation?.paint.kind === 'known'
        ? observation.paint.foreground
        : undefined
    const expectedSurface = parseSrgbColor(target.parameters.targetSurface)!
    const expectedText = parseSrgbColor(target.parameters.targetText)!
    const sourceText = parseSrgbColor(target.parameters.sourceText)!
    const contrast = surface && text ? contrastRatio(text, surface) : 0
    const targetPassed = Boolean(
      surface &&
        text &&
        sameRgb(surface, expectedSurface) &&
        sameRgb(text, expectedText) &&
        contrast >= target.parameters.minimumTextContrast,
    )
    let descendantSamples = 0
    let descendantPaintPreserved =
      !health.truncated && !layer.publishedHealth.truncated
    for (const before of layer.publishedHealth.observations) {
      if (
        !before.directMeaningfulText ||
        before.element === target.element ||
        !target.element.contains(before.element)
      ) {
        continue
      }
      descendantSamples += 1
      const after = byElement.get(before.element)
      if (before.paint.kind !== 'known' || after?.paint.kind !== 'known') {
        descendantPaintPreserved = false
        continue
      }
      const surfaceOwner =
        before.paint.surface.kind === 'element'
          ? layer.publishedHealth.observations[
              before.paint.surface.observationIndex
            ]?.element
          : undefined
      const expectedDescendantSurface =
        surfaceOwner === target.element
          ? expectedSurface
          : before.paint.background
      const expectedDescendantText = sameRgb(
        before.paint.foreground,
        sourceText,
      )
        ? expectedText
        : before.paint.foreground
      const contrastPreserved =
        before.paint.contrast < target.parameters.minimumTextContrast
          ? after.paint.contrast + 0.01 >= before.paint.contrast
          : after.paint.contrast >= target.parameters.minimumTextContrast
      if (
        !sameRgb(after.paint.background, expectedDescendantSurface) ||
        !sameRgb(after.paint.foreground, expectedDescendantText) ||
        !contrastPreserved
      ) {
        descendantPaintPreserved = false
      }
    }
    // Every adapted observation must have existed in the Published snapshot;
    // otherwise the bounded comparison is incomplete and cannot be admitted.
    if (
      health.observations.some(
        (after) =>
          after.directMeaningfulText &&
          after.element !== target.element &&
          target.element.contains(after.element) &&
          !publishedByElement.has(after.element),
      )
    ) {
      descendantPaintPreserved = false
    }
    const passed = targetPassed && descendantPaintPreserved
    const id = `opaque-palette-contrast:${index}`
    probes.push({
      id,
      probeVersion: OPAQUE_PALETTE_VALIDATOR_VERSION,
      passed,
      confidence: passed ? 0.99 : 1,
      metrics: {
        paintKnown: knownPaint,
        truncated: health.truncated,
        contrast,
        minimumContrast: target.parameters.minimumTextContrast,
        observedSurface: surface ? srgbToHex(surface) : 'unresolved',
        observedText: text ? srgbToHex(text) : 'unresolved',
        descendantSamples,
        descendantPaintPreserved,
      },
    })
    if (!passed) {
      failureReasons.push({
        code: targetPassed
          ? 'opaque-palette-descendant-paint-changed'
          : 'opaque-palette-contrast-failed',
        findingIds: [],
        patchIds: [],
      })
    }
  }
  if (!geometryStable) {
    failureReasons.push({
      code: 'paint-operation-changed-geometry',
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
    validatorVersion: OPAQUE_PALETTE_VALIDATOR_VERSION,
    passed,
    confidence: passed
      ? Math.min(...probes.map((probe) => probe.confidence))
      : 1,
    probes,
    geometryStable,
    failureReasons,
  }
  // Assert that diagnostics remain serializable before they reach the gate.
  canonicalJson(input)
  return { input, geometryBefore: withoutLayer, geometryAfter: restored }
}

import { canonicalJson, type CanonicalJsonValue } from './canonical-json'
import {
  contrastRatio,
  oklchToSrgbGamut,
  parseSrgbColor,
  relativeLuminance,
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
  applyReversibleInlineStyle,
  suspendInlineStyles,
  type ReversibleInlineStyleOverride,
} from './presentation-inline-style'
import {
  createSourceNodeSignature,
  getSourceTreeRoot,
  resolveSourceTreeAddress,
  SOURCE_TREE_MODEL_VERSION,
  walkSourceTree,
  type SourceTreeAddress,
} from './source-tree'

export const INHERITED_FOREGROUND_ANALYZER_VERSION = 9 as const
export const RESTORE_VISIBLE_TEXT_OPERATION_VERSION = 3 as const
export const INHERITED_FOREGROUND_VALIDATOR_VERSION = 7 as const
// A single short, rendered label can be the only non-link text in a TOC or
// title page. Length is not a safety boundary: complete paint evidence,
// inheritance identity, regression checks and post-pagination validation are.
export const DEFAULT_MINIMUM_REPAIR_TEXT_CODE_POINTS = 1 as const

const LAYER_ATTRIBUTE = 'data-lumen-presentation-layer'
const TARGET_ATTRIBUTE = 'data-lumen-visible-text-target'
const HEX_COLOR = /^#[0-9a-f]{6}$/

export type RestoreVisibleTextParameters = {
  schemaVersion: 2
  sourceText: string
  targetText: string
  canvas: string
  minimumTextContrast: number
  minimumRepairCoverage: number
  minimumRepairTextCodePoints: number
  observedLowContrastSamples: number
  observedTargetedSamples: number
  observedRepairableSamples: number
  observedLowContrastTextCodePoints: number
  observedTargetedTextCodePoints: number
  observedRepairableTextCodePoints: number
}

export type InheritedForegroundAnalysisOptions = {
  sourceDocument: Document
  renderedDocument: Document
  spineIndex: number
  canvasColor: string
  signal?: AbortSignal
  minimumTextContrast?: number
  preferredTextContrast?: number
  minimumRepairCoverage?: number
  minimumRepairTextCodePoints?: number
  maxInspectedElements?: number
  /** This analyzer emits at most one repair, but must share the run budget. */
  maxCandidates?: number
  healthMap?: PresentationHealthMap
}

export type InheritedForegroundAnalysis = {
  findings: PresentationFinding[]
  patches: PresentationPatch[]
  inspectedElements: number
  eligibleSamples: number
  lowContrastSamples: number
  repairableSamples: number
  lowContrastTextCodePoints: number
  repairableTextCodePoints: number
  /** Runtime-only evidence reused by the immediately following apply step. */
  runtimeEvidence?: InheritedForegroundRuntimeEvidence
}

export type InheritedForegroundRuntimeEvidence = {
  evidenceVersion: 1
  renderedDocument: Document
  spineIndex: number
  canvas: string
  publishedHealth: PresentationHealthMap
}

type TextSample = {
  element: Element
  foreground: SrgbColor
  background: SrgbColor
  contrast: number
  directTextCodePoints: number
}

type GeometrySnapshot = {
  scrollWidth: number
  scrollHeight: number
  rootWidth: number
  rootHeight: number
}

export type AppliedInheritedForegroundLayer = {
  planHash: string
  document: Document
  style: HTMLStyleElement
  target: Element
  previousMarker: string | null
  marker: string
  colorOverride: ReversibleInlineStyleOverride
  parameters: RestoreVisibleTextParameters
  before: TextSample[]
  /** Includes visible text whose paint could not be reduced to solid colors. */
  publishedHealth: PresentationHealthMap
  spineIndex: number
  inspectedElements: number
  restore: () => void
}

export type InheritedForegroundValidation = {
  input: ValidationRecordInput
  repairedSamples: number
  unresolvedSamples: number
}

const appliedLayers = new WeakMap<Document, AppliedInheritedForegroundLayer>()

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

export function isRestoreVisibleTextParameters(
  value: unknown,
): value is RestoreVisibleTextParameters {
  if (
    !isExactObject(value, [
      'schemaVersion',
      'sourceText',
      'targetText',
      'canvas',
      'minimumTextContrast',
      'minimumRepairCoverage',
      'minimumRepairTextCodePoints',
      'observedLowContrastSamples',
      'observedTargetedSamples',
      'observedRepairableSamples',
      'observedLowContrastTextCodePoints',
      'observedTargetedTextCodePoints',
      'observedRepairableTextCodePoints',
    ])
  ) {
    return false
  }
  return (
    value.schemaVersion === 2 &&
    typeof value.sourceText === 'string' &&
    HEX_COLOR.test(value.sourceText) &&
    typeof value.targetText === 'string' &&
    HEX_COLOR.test(value.targetText) &&
    typeof value.canvas === 'string' &&
    HEX_COLOR.test(value.canvas) &&
    typeof value.minimumTextContrast === 'number' &&
    Number.isFinite(value.minimumTextContrast) &&
    value.minimumTextContrast >= 1 &&
    value.minimumTextContrast <= 21 &&
    typeof value.minimumRepairCoverage === 'number' &&
    value.minimumRepairCoverage >= 0.5 &&
    value.minimumRepairCoverage <= 1 &&
    Number.isInteger(value.minimumRepairTextCodePoints) &&
    (value.minimumRepairTextCodePoints as number) > 0 &&
    Number.isInteger(value.observedLowContrastSamples) &&
    (value.observedLowContrastSamples as number) > 0 &&
    Number.isInteger(value.observedTargetedSamples) &&
    (value.observedTargetedSamples as number) > 0 &&
    (value.observedTargetedSamples as number) <=
      (value.observedLowContrastSamples as number) &&
    Number.isInteger(value.observedRepairableSamples) &&
    (value.observedRepairableSamples as number) > 0 &&
    (value.observedRepairableSamples as number) <=
      (value.observedTargetedSamples as number) &&
    Number.isInteger(value.observedLowContrastTextCodePoints) &&
    (value.observedLowContrastTextCodePoints as number) > 0 &&
    Number.isInteger(value.observedTargetedTextCodePoints) &&
    (value.observedTargetedTextCodePoints as number) > 0 &&
    (value.observedTargetedTextCodePoints as number) <=
      (value.observedLowContrastTextCodePoints as number) &&
    Number.isInteger(value.observedRepairableTextCodePoints) &&
    (value.observedRepairableTextCodePoints as number) > 0 &&
    (value.observedRepairableTextCodePoints as number) <=
      (value.observedTargetedTextCodePoints as number)
  )
}

export const RESTORE_VISIBLE_TEXT_OPERATION_VALIDATORS: PresentationOperationValidators =
  {
    'restore-visible-text': (parameters, patch) =>
      isRestoreVisibleTextParameters(parameters) &&
      patch.operationVersion === RESTORE_VISIBLE_TEXT_OPERATION_VERSION &&
      patch.effects.paint === true &&
      patch.effects.geometry === 'none' &&
      patch.effects.semantics === 'none',
  }

function captureTextSamples(
  document: Document,
  canvas: SrgbColor,
  maxInspectedElements: number,
  spineIndex = 0,
  suppliedHealth?: PresentationHealthMap,
): {
  samples: TextSample[]
  inspectedElements: number
  truncated: boolean
  health: PresentationHealthMap
} {
  const maximum = Math.max(0, maxInspectedElements)
  const reusable =
    suppliedHealth?.modelVersion === PRESENTATION_HEALTH_MODEL_VERSION &&
    suppliedHealth.spineIndex === spineIndex &&
    suppliedHealth.renderedDocument === document &&
    suppliedHealth.canvas !== undefined &&
    srgbToHex(suppliedHealth.canvas) === srgbToHex(canvas) &&
    suppliedHealth.observations.every(
      (observation) => observation.element.ownerDocument === document,
    )
      ? suppliedHealth
      : undefined
  const health =
    reusable ??
    createPresentationHealthMap({
      renderedDocument: document,
      // Runtime samples are matched by Element identity; they are not persisted.
      spineIndex,
      canvasColor: canvas,
      // The source root was not counted by the original analyzer budget.
      maxInspectedElements: maximum + 1,
    })
  const allEligible = health.observations.filter(
    (observation) =>
      observation.address.sourcePath.length > 0 ||
      observation.directMeaningfulText,
  )
  const truncated = health.truncated || allEligible.length > maximum
  const eligible = allEligible.slice(0, maximum)
  const samples = eligible.flatMap((observation): TextSample[] => {
    if (!observation.textPaintEligible || observation.paint.kind !== 'known') {
      return []
    }
    return [
      {
        element: observation.element,
        foreground: observation.paint.foreground,
        background: observation.paint.background,
        contrast: observation.paint.contrast,
        directTextCodePoints: observation.directTextCodePoints,
      },
    ]
  })
  return {
    samples,
    inspectedElements: eligible.length,
    truncated,
    health,
  }
}

function readableForeground(
  source: SrgbColor,
  canvas: SrgbColor,
  preferredContrast: number,
): SrgbColor | undefined {
  if (
    source.a < 0.999 ||
    canvas.a < 0.999 ||
    relativeLuminance(canvas) > 0.22
  ) {
    return undefined
  }
  const sourceLch = srgbToOklch(source)
  const chroma = Math.min(sourceLch.c, 0.08)
  for (let lightness = 0.62; lightness <= 1.0001; lightness += 0.01) {
    const candidate = oklchToSrgbGamut({
      l: lightness,
      c: chroma,
      h: sourceLch.h,
    })
    if (contrastRatio(candidate, canvas) >= preferredContrast) return candidate
  }
  const white = { r: 1, g: 1, b: 1, a: 1 }
  return contrastRatio(white, canvas) >= preferredContrast ? white : undefined
}

function bodyAddress(
  document: Document,
  spineIndex: number,
): SourceTreeAddress | undefined {
  const body = document.body
  if (!body) return undefined
  let result: SourceTreeAddress | undefined
  walkSourceTree(document, ({ node, nodeKind, sourcePath }) => {
    if (node === body && nodeKind === 'element') {
      result = {
        sourceModelVersion: SOURCE_TREE_MODEL_VERSION,
        spineIndex,
        nodeKind: 'element',
        sourcePath: [...sourcePath],
      }
      return 'stop'
    }
    return 'continue'
  })
  return result
}

function appendLayer(document: Document): HTMLStyleElement {
  const style = document.createElementNS(
    'http://www.w3.org/1999/xhtml',
    'style',
  ) as HTMLStyleElement
  markPresentationRuntimeNode(style)
  style.setAttribute(LAYER_ATTRIBUTE, 'visible-text-v3')
  ;(document.head ?? document.documentElement).appendChild(style)
  return style
}

function geometrySnapshot(document: Document): GeometrySnapshot {
  const root = getSourceTreeRoot(document)
  const rect = root.getBoundingClientRect()
  return {
    scrollWidth: root.scrollWidth,
    scrollHeight: root.scrollHeight,
    rootWidth: rect.width,
    rootHeight: rect.height,
  }
}

function sameGeometry(
  left: GeometrySnapshot,
  right: GeometrySnapshot,
  epsilon = 0.5,
): boolean {
  return (
    Math.abs(left.scrollWidth - right.scrollWidth) <= epsilon &&
    Math.abs(left.scrollHeight - right.scrollHeight) <= epsilon &&
    Math.abs(left.rootWidth - right.rootWidth) <= epsilon &&
    Math.abs(left.rootHeight - right.rootHeight) <= epsilon
  )
}

function repairedCounts(
  before: readonly TextSample[],
  document: Document,
  canvas: SrgbColor,
  minimumContrast: number,
  maxInspectedElements: number,
  spineIndex: number,
  suppliedHealth?: PresentationHealthMap,
): {
  low: number
  targeted: number
  repaired: number
  regressions: number
  lowTextCodePoints: number
  targetedTextCodePoints: number
  repairedTextCodePoints: number
  unresolvedNeutralSamples: number
  unresolvedNeutralTextCodePoints: number
  truncated: boolean
} {
  const captured = captureTextSamples(
    document,
    canvas,
    maxInspectedElements,
    spineIndex,
    suppliedHealth,
  )
  const after = captured.samples
  const afterByElement = new WeakMap<Element, TextSample>()
  after.forEach((sample) => afterByElement.set(sample.element, sample))
  let low = 0
  let targeted = 0
  let repaired = 0
  let regressions = 0
  let lowTextCodePoints = 0
  let targetedTextCodePoints = 0
  let repairedTextCodePoints = 0
  let unresolvedNeutralSamples = 0
  let unresolvedNeutralTextCodePoints = 0
  for (const sample of before) {
    const observedAfter = afterByElement.get(sample.element)
    if (sample.contrast < minimumContrast) {
      low += 1
      lowTextCodePoints += sample.directTextCodePoints
      if (
        observedAfter &&
        srgbToHex(observedAfter.foreground) !== srgbToHex(sample.foreground)
      ) {
        targeted += 1
        targetedTextCodePoints += sample.directTextCodePoints
        if (observedAfter.contrast >= minimumContrast) {
          repaired += 1
          repairedTextCodePoints += sample.directTextCodePoints
        }
      }
      const sourceLch = srgbToOklch(sample.foreground)
      if (
        (!observedAfter || observedAfter.contrast < minimumContrast) &&
        sourceLch.c <= 0.035 &&
        relativeLuminance(sample.foreground) <= 0.35
      ) {
        unresolvedNeutralSamples += 1
        unresolvedNeutralTextCodePoints += sample.directTextCodePoints
      }
    } else if (!observedAfter || observedAfter.contrast < minimumContrast) {
      regressions += 1
    }
  }
  return {
    low,
    targeted,
    repaired,
    regressions,
    lowTextCodePoints,
    targetedTextCodePoints,
    repairedTextCodePoints,
    unresolvedNeutralSamples,
    unresolvedNeutralTextCodePoints,
    truncated: captured.truncated,
  }
}

function hasSufficientRepairEvidence(
  counts: ReturnType<typeof repairedCounts>,
  minimumRepairTextCodePoints: number,
): boolean {
  const repeatedSamples = counts.targeted >= 2 && counts.repaired >= 2
  const substantialSingleSample =
    counts.targeted >= 1 &&
    counts.repaired >= 1 &&
    counts.targetedTextCodePoints >= minimumRepairTextCodePoints &&
    counts.repairedTextCodePoints >= minimumRepairTextCodePoints
  return repeatedSamples || substantialSingleSample
}

export async function analyzeInheritedForegroundForDarkTheme(
  options: InheritedForegroundAnalysisOptions,
): Promise<InheritedForegroundAnalysis> {
  const { sourceDocument, renderedDocument, spineIndex, signal } = options
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
  const minimumRepairCoverage = boundedNumber(
    options.minimumRepairCoverage,
    0.8,
    0.5,
    1,
  )
  const requestedMinimumRepairTextCodePoints =
    options.minimumRepairTextCodePoints ??
    DEFAULT_MINIMUM_REPAIR_TEXT_CODE_POINTS
  const maxInspectedElements = boundedInteger(
    options.maxInspectedElements,
    512,
    0,
    MAX_PRESENTATION_HEALTH_ELEMENTS - 1,
  )
  const minimumRepairTextCodePoints =
    Number.isInteger(requestedMinimumRepairTextCodePoints) &&
    requestedMinimumRepairTextCodePoints > 0
      ? Math.min(requestedMinimumRepairTextCodePoints, 10_000)
      : DEFAULT_MINIMUM_REPAIR_TEXT_CODE_POINTS
  const empty = (inspectedElements = 0): InheritedForegroundAnalysis => ({
    findings: [],
    patches: [],
    inspectedElements,
    eligibleSamples: 0,
    lowContrastSamples: 0,
    repairableSamples: 0,
    lowContrastTextCodePoints: 0,
    repairableTextCodePoints: 0,
  })
  const maxCandidates = Math.max(
    0,
    Math.min(
      1,
      Number.isFinite(options.maxCandidates)
        ? Math.floor(options.maxCandidates!)
        : 1,
    ),
  )
  if (maxCandidates === 0) return empty()
  const canvas = parseSrgbColor(options.canvasColor)
  const view = renderedDocument.defaultView
  const renderedBody = renderedDocument.body
  if (
    !canvas ||
    canvas.a < 0.999 ||
    relativeLuminance(canvas) > 0.22 ||
    !view ||
    !renderedBody
  ) {
    return empty()
  }

  const captured = captureTextSamples(
    renderedDocument,
    canvas,
    Math.max(0, maxInspectedElements),
    spineIndex,
    options.healthMap,
  )
  // A body-wide override must not be inferred from a prefix of the chapter.
  if (captured.truncated) return empty(captured.inspectedElements)
  const lowContrast = captured.samples.filter(
    (sample) => sample.contrast < minimumTextContrast,
  )
  const lowContrastTextCodePoints = lowContrast.reduce(
    (total, sample) => total + sample.directTextCodePoints,
    0,
  )
  if (
    lowContrast.length === 0 ||
    (lowContrast.length < 2 &&
      lowContrastTextCodePoints < minimumRepairTextCodePoints)
  ) {
    return {
      ...empty(captured.inspectedElements),
      eligibleSamples: captured.samples.length,
      lowContrastSamples: lowContrast.length,
      lowContrastTextCodePoints,
    }
  }

  const sourceText = resolveComputedSrgbColor(
    view.getComputedStyle(renderedBody).color,
    renderedBody,
  )
  const targetText =
    sourceText &&
    readableForeground(
      sourceText,
      canvas,
      Math.max(minimumTextContrast, preferredTextContrast),
    )
  if (!sourceText || !targetText) return empty(captured.inspectedElements)

  const sameSource = (sample: TextSample): boolean =>
    srgbToHex(sample.foreground) === srgbToHex(sourceText)
  const healthByElement = new WeakMap(
    captured.health.observations.map((observation) => [
      observation.element,
      observation,
    ]),
  )
  const hasInlineAuthoredColor = (sample: TextSample): boolean => {
    const observation = healthByElement.get(sample.element)
    if (!observation) return true
    const sourceNode = resolveSourceTreeAddress(
      sourceDocument,
      observation.address,
      spineIndex,
    )
    return (
      sourceNode?.nodeType === 1 &&
      Boolean(
        (sourceNode as Element)
          .getAttribute('style')
          ?.match(/(?:^|;)\s*color\s*:/iu),
      )
    )
  }
  const targeted = lowContrast.filter(sameSource)
  const repairable = targeted.filter(
    (sample) =>
      contrastRatio(targetText, sample.background) >= minimumTextContrast,
  )
  const unresolvedNeutral = lowContrast.filter((sample) => {
    const sourceLch = srgbToOklch(sample.foreground)
    return (
      (!sameSource(sample) || hasInlineAuthoredColor(sample)) &&
      sourceLch.c <= 0.035 &&
      relativeLuminance(sample.foreground) <= 0.35
    )
  })
  const regressions = captured.samples.filter(
    (sample) =>
      sample.contrast >= minimumTextContrast &&
      sameSource(sample) &&
      contrastRatio(targetText, sample.background) < minimumTextContrast,
  )
  const sumCodePoints = (samples: readonly TextSample[]): number =>
    samples.reduce((total, sample) => total + sample.directTextCodePoints, 0)
  const counts: ReturnType<typeof repairedCounts> = {
    low: lowContrast.length,
    targeted: targeted.length,
    repaired: repairable.length,
    regressions: regressions.length,
    lowTextCodePoints: lowContrastTextCodePoints,
    targetedTextCodePoints: sumCodePoints(targeted),
    repairedTextCodePoints: sumCodePoints(repairable),
    unresolvedNeutralSamples: unresolvedNeutral.length,
    unresolvedNeutralTextCodePoints: sumCodePoints(unresolvedNeutral),
    truncated: false,
  }
  // Candidate analysis remains non-mutating. It predicts the body-inherited
  // subset from complete Published evidence; the final, post-pagination gate
  // still measures every changed sample and rejects/rolls back if a descendant
  // had an explicit declaration indistinguishable from inheritance here.
  const coverage = counts.targeted > 0 ? counts.repaired / counts.targeted : 0
  if (
    !hasSufficientRepairEvidence(counts, minimumRepairTextCodePoints) ||
    coverage < minimumRepairCoverage ||
    counts.regressions > 0 ||
    counts.unresolvedNeutralSamples > 0 ||
    counts.truncated
  ) {
    return {
      ...empty(captured.inspectedElements),
      eligibleSamples: captured.samples.length,
      lowContrastSamples: counts.low,
      repairableSamples: counts.repaired,
      lowContrastTextCodePoints: counts.lowTextCodePoints,
      repairableTextCodePoints: counts.repairedTextCodePoints,
    }
  }

  const address = bodyAddress(renderedDocument, spineIndex)
  if (!address) return empty(captured.inspectedElements)
  const sourceNode = resolveSourceTreeAddress(
    sourceDocument,
    address,
    spineIndex,
  )
  if (!sourceNode || sourceNode.nodeType !== 1) {
    return empty(captured.inspectedElements)
  }
  const signature = await createSourceNodeSignature(sourceNode)
  throwIfAborted(signal)
  if (!signature) return empty(captured.inspectedElements)

  const findingId = `inherited-foreground:${spineIndex}`
  const patchId = `restore-visible-text:${spineIndex}`
  const target = { source: address, sourceSignature: signature }
  const parameters: RestoreVisibleTextParameters = {
    schemaVersion: 2,
    sourceText: srgbToHex(sourceText),
    targetText: srgbToHex(targetText),
    canvas: srgbToHex(canvas),
    minimumTextContrast,
    minimumRepairCoverage,
    minimumRepairTextCodePoints,
    observedLowContrastSamples: counts.low,
    observedTargetedSamples: counts.targeted,
    observedRepairableSamples: counts.repaired,
    observedLowContrastTextCodePoints: counts.lowTextCodePoints,
    observedTargetedTextCodePoints: counts.targetedTextCodePoints,
    observedRepairableTextCodePoints: counts.repairedTextCodePoints,
  }
  const findings: PresentationFinding[] = [
    {
      id: findingId,
      analyzerId: 'lumen.inherited-foreground.dark',
      analyzerVersion: INHERITED_FOREGROUND_ANALYZER_VERSION,
      kind: 'inherited-dark-text-on-dark-canvas',
      confidence: 0.98,
      target,
      evidence: {
        sourceText: parameters.sourceText,
        targetText: parameters.targetText,
        canvas: parameters.canvas,
        eligibleSamples: captured.samples.length,
        lowContrastSamples: counts.low,
        targetedSamples: counts.targeted,
        repairableSamples: counts.repaired,
        lowContrastTextCodePoints: counts.lowTextCodePoints,
        targetedTextCodePoints: counts.targetedTextCodePoints,
        repairableTextCodePoints: counts.repairedTextCodePoints,
        minimumRepairTextCodePoints,
        repairCoverage: coverage,
      },
    },
  ]
  const patches: PresentationPatch[] = [
    {
      id: patchId,
      operationVersion: RESTORE_VISIBLE_TEXT_OPERATION_VERSION,
      target,
      operation: 'restore-visible-text',
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
        changedProperties: 1,
      },
      dependencies: [],
      conflicts: [],
    },
  ]
  return {
    findings,
    patches,
    inspectedElements: captured.inspectedElements,
    eligibleSamples: captured.samples.length,
    lowContrastSamples: counts.low,
    repairableSamples: counts.repaired,
    lowContrastTextCodePoints: counts.lowTextCodePoints,
    repairableTextCodePoints: counts.repairedTextCodePoints,
    runtimeEvidence: {
      evidenceVersion: 1,
      renderedDocument,
      spineIndex,
      canvas: srgbToHex(canvas),
      publishedHealth: captured.health,
    },
  }
}

export async function applyRestoreVisibleTextPlan(
  plan: PresentationPlan,
  sourceDocument: Document,
  renderedDocument: Document,
  expectedSpineIndex: number,
  signal?: AbortSignal,
  runtimeEvidence?: InheritedForegroundRuntimeEvidence,
): Promise<AppliedInheritedForegroundLayer | undefined> {
  restoreInheritedForegroundLayer(renderedDocument)
  const patch = plan.patches.find(
    (candidate) => candidate.operation === 'restore-visible-text',
  )
  if (!patch) return undefined
  if (
    patch.operationVersion !== RESTORE_VISIBLE_TEXT_OPERATION_VERSION ||
    patch.effects.paint !== true ||
    patch.effects.geometry !== 'none' ||
    patch.effects.semantics !== 'none' ||
    !isRestoreVisibleTextParameters(patch.parameters)
  ) {
    throw new TypeError('Plan contains an unsupported visible-text operation')
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
    throw new Error('Visible-text source target is stale')
  }
  const signature = await createSourceNodeSignature(sourceNode)
  throwIfAborted(signal)
  if (!signature || signature !== patch.target.sourceSignature) {
    throw new Error('Visible-text source signature is stale')
  }

  const canvas = parseSrgbColor(patch.parameters.canvas)!
  const target = renderedNode as Element
  const renderedSourceText = resolveComputedSrgbColor(
    renderedDocument.defaultView?.getComputedStyle(target).color ?? '',
    target,
  )
  if (
    !renderedSourceText ||
    srgbToHex(renderedSourceText) !== patch.parameters.sourceText
  ) {
    throw new Error('Visible-text render evidence is stale')
  }
  // Reuse complete evidence from this lifecycle when possible; direct callers
  // still rebuild the whole bounded document instead of trusting a prefix.
  const reusableEvidence =
    runtimeEvidence?.evidenceVersion === 1 &&
    runtimeEvidence.renderedDocument === renderedDocument &&
    runtimeEvidence.spineIndex === expectedSpineIndex &&
    runtimeEvidence.canvas === patch.parameters.canvas &&
    runtimeEvidence.publishedHealth.renderedDocument === renderedDocument &&
    !runtimeEvidence.publishedHealth.truncated
      ? runtimeEvidence
      : undefined
  const publishedHealth =
    reusableEvidence?.publishedHealth ??
    createPresentationHealthMap({
      renderedDocument,
      spineIndex: expectedSpineIndex,
      canvasColor: canvas,
      signal,
      maxInspectedElements: MAX_PRESENTATION_HEALTH_ELEMENTS,
    })
  if (publishedHealth.truncated) {
    throw new Error('Visible-text validation sample is truncated')
  }
  const captured = captureTextSamples(
    renderedDocument,
    canvas,
    MAX_PRESENTATION_HEALTH_ELEMENTS - 1,
    expectedSpineIndex,
    publishedHealth,
  )
  if (captured.truncated) {
    throw new Error('Visible-text validation sample is truncated')
  }
  const before = captured.samples
  const marker = createPresentationRuntimeMarker(
    renderedDocument,
    'visible-text',
    TARGET_ATTRIBUTE,
  )
  const previousMarker = target.getAttribute(TARGET_ATTRIBUTE)
  target.setAttribute(TARGET_ATTRIBUTE, marker)
  const style = appendLayer(renderedDocument)
  const colorOverride = applyReversibleInlineStyle(
    target,
    'color',
    patch.parameters.targetText,
  )
  let restored = false
  const restore = (): void => {
    if (restored) return
    restored = true
    colorOverride.restore()
    style.remove()
    if (previousMarker === null) target.removeAttribute(TARGET_ATTRIBUTE)
    else target.setAttribute(TARGET_ATTRIBUTE, previousMarker)
    if (appliedLayers.get(renderedDocument)?.restore === restore) {
      appliedLayers.delete(renderedDocument)
    }
  }
  const layer: AppliedInheritedForegroundLayer = {
    planHash: plan.planHash,
    document: renderedDocument,
    style,
    target,
    previousMarker,
    marker,
    colorOverride,
    parameters: patch.parameters,
    before,
    publishedHealth,
    spineIndex: expectedSpineIndex,
    inspectedElements: captured.inspectedElements,
    restore,
  }
  appliedLayers.set(renderedDocument, layer)
  return layer
}

export function restoreInheritedForegroundLayer(document: Document): void {
  appliedLayers.get(document)?.restore()
}

export function validateRestoredVisibleText(
  layer: AppliedInheritedForegroundLayer,
): InheritedForegroundValidation {
  const view = layer.document.defaultView
  const canvas = parseSrgbColor(layer.parameters.canvas)!
  if (!layer.style.isConnected || !view) {
    throw new Error('Visible-text layer marker is unavailable')
  }

  const enabledGeometry = geometrySnapshot(layer.document)
  let publishedGeometry: GeometrySnapshot
  const resume = suspendInlineStyles([layer.colorOverride])
  try {
    publishedGeometry = geometrySnapshot(layer.document)
  } finally {
    resume()
  }
  const restoredGeometry = geometrySnapshot(layer.document)
  const geometryStable =
    sameGeometry(enabledGeometry, publishedGeometry) &&
    sameGeometry(enabledGeometry, restoredGeometry)
  const adaptedHealth = createPresentationHealthMap({
    renderedDocument: layer.document,
    spineIndex: layer.spineIndex,
    canvasColor: canvas,
    maxInspectedElements: MAX_PRESENTATION_HEALTH_ELEMENTS,
  })
  const counts = repairedCounts(
    layer.before,
    layer.document,
    canvas,
    layer.parameters.minimumTextContrast,
    layer.inspectedElements,
    layer.spineIndex,
    adaptedHealth,
  )
  const adaptedByElement = new WeakMap(
    adaptedHealth.observations.map((observation) => [
      observation.element,
      observation,
    ]),
  )
  let unprovenPaintChanges = 0
  for (const before of layer.publishedHealth.observations) {
    const visibleMeaningfulText =
      before.directMeaningfulText &&
      before.style.display !== 'none' &&
      before.style.visibility === 'visible' &&
      before.style.contentVisibility !== 'hidden' &&
      before.geometry.clientRectCount > 0
    const alreadyProven =
      before.textPaintEligible && before.paint.kind === 'known'
    if (!visibleMeaningfulText || alreadyProven) continue
    const after = adaptedByElement.get(before.element)
    if (!after || before.style.color !== after.style.color) {
      unprovenPaintChanges += 1
    }
  }
  const coverage = counts.targeted > 0 ? counts.repaired / counts.targeted : 0
  const observedTarget = resolveComputedSrgbColor(
    view.getComputedStyle(layer.target).color,
    layer.target,
  )
  const expectedTarget = parseSrgbColor(layer.parameters.targetText)!
  const targetApplied =
    observedTarget !== undefined &&
    srgbToHex(observedTarget) === srgbToHex(expectedTarget)
  const sufficientEvidence = hasSufficientRepairEvidence(
    counts,
    layer.parameters.minimumRepairTextCodePoints,
  )
  const passed =
    targetApplied &&
    sufficientEvidence &&
    coverage >= layer.parameters.minimumRepairCoverage &&
    counts.regressions === 0 &&
    counts.unresolvedNeutralSamples === 0 &&
    unprovenPaintChanges === 0 &&
    !adaptedHealth.truncated &&
    !counts.truncated &&
    geometryStable
  const probes: ProbeResult[] = [
    {
      id: 'inherited-foreground-coverage',
      probeVersion: INHERITED_FOREGROUND_VALIDATOR_VERSION,
      passed:
        targetApplied &&
        sufficientEvidence &&
        coverage >= layer.parameters.minimumRepairCoverage &&
        counts.regressions === 0 &&
        counts.unresolvedNeutralSamples === 0 &&
        unprovenPaintChanges === 0 &&
        !adaptedHealth.truncated &&
        !counts.truncated,
      confidence: passed ? 0.98 : 1,
      metrics: {
        targetApplied,
        lowContrastSamples: counts.low,
        targetedSamples: counts.targeted,
        repairedSamples: counts.repaired,
        unresolvedSamples: counts.targeted - counts.repaired,
        regressions: counts.regressions,
        lowContrastTextCodePoints: counts.lowTextCodePoints,
        targetedTextCodePoints: counts.targetedTextCodePoints,
        repairedTextCodePoints: counts.repairedTextCodePoints,
        unresolvedNeutralSamples: counts.unresolvedNeutralSamples,
        unresolvedNeutralTextCodePoints: counts.unresolvedNeutralTextCodePoints,
        unprovenPaintChanges,
        minimumRepairTextCodePoints:
          layer.parameters.minimumRepairTextCodePoints,
        repairCoverage: coverage,
        minimumRepairCoverage: layer.parameters.minimumRepairCoverage,
        truncated: counts.truncated,
      },
    },
    {
      id: 'inherited-foreground-geometry',
      probeVersion: INHERITED_FOREGROUND_VALIDATOR_VERSION,
      passed: geometryStable,
      confidence: geometryStable ? 0.99 : 1,
      metrics: {},
    },
  ]
  const failureReasons: ValidationFailure[] = []
  if (!probes[0]!.passed) {
    failureReasons.push({
      code: 'inherited-foreground-insufficient-repair',
      findingIds: [],
      patchIds: [],
    })
  }
  if (!geometryStable) {
    failureReasons.push({
      code: 'paint-operation-changed-geometry',
      findingIds: [],
      patchIds: [],
    })
  }
  const input: ValidationRecordInput = {
    validatorVersion: INHERITED_FOREGROUND_VALIDATOR_VERSION,
    passed,
    confidence: passed ? 0.98 : 1,
    probes,
    geometryStable,
    failureReasons,
  }
  canonicalJson(input)
  return {
    input,
    repairedSamples: counts.repaired,
    unresolvedSamples: counts.targeted - counts.repaired,
  }
}

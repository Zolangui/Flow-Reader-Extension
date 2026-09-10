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
} from './presentation-health'
import {
  applyReversibleInlineStyle,
  suspendInlineStyles,
  type ReversibleInlineStyleOverride,
} from './presentation-inline-style'
import { boundedInteger, boundedNumber } from './presentation-options'
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
  getSourceTreeRoot,
  resolveSourceTreeAddress,
  SOURCE_TREE_MODEL_VERSION,
} from './source-tree'

export const STROKE_CONTRAST_ANALYZER_VERSION = 2 as const
export const RESTORE_VISIBLE_STROKE_OPERATION_VERSION = 2 as const
export const STROKE_CONTRAST_VALIDATOR_VERSION = 1 as const

const HEX_COLOR = /^#[0-9a-f]{6}$/iu
const FLAT_BORDER_STYLES = new Set(['solid', 'dashed', 'dotted', 'double'])

export type PresentationStrokeSide = 'top' | 'right' | 'bottom' | 'left'

type StrokeColorProperty =
  | 'borderTopColor'
  | 'borderRightColor'
  | 'borderBottomColor'
  | 'borderLeftColor'
type StrokeStyleProperty =
  | 'borderTopStyle'
  | 'borderRightStyle'
  | 'borderBottomStyle'
  | 'borderLeftStyle'
type StrokeWidthProperty =
  | 'borderTopWidth'
  | 'borderRightWidth'
  | 'borderBottomWidth'
  | 'borderLeftWidth'

export type RestoreVisibleStrokeParameters = {
  schemaVersion: 2
  sourceStroke: string
  targetStroke: string
  canvas: string
  surfaces: string[]
  minimumStrokeContrast: number
  observedSides: number
  strokes: Array<{
    sourcePath: number[]
    side: PresentationStrokeSide
  }>
}

export type StrokeContrastAnalysisOptions = {
  sourceDocument: Document
  renderedDocument: Document
  spineIndex: number
  canvasColor: string
  signal?: AbortSignal
  minimumStrokeContrast?: number
  maxCandidates?: number
  healthMap?: PresentationHealthMap
}

export type StrokeContrastAnalysis = {
  findings: PresentationFinding[]
  patches: PresentationPatch[]
  inspectedElements: number
  candidateGroups: number
  truncatedGroups: number
  diagnostics: string[]
}

type StrokeSample = {
  observation: PresentationHealthObservation
  side: PresentationStrokeSide
  color: SrgbColor
  background: SrgbColor
  contrast: number
}

type CandidateGroup = {
  root: PresentationHealthObservation
  sourceStroke: SrgbColor
  samples: StrokeSample[]
}

type AppliedStroke = {
  element: Element
  side: PresentationStrokeSide
  override: ReversibleInlineStyleOverride
}

type AppliedTarget = {
  sourceRoot: Element
  root: Element
  strokes: AppliedStroke[]
  parameters: RestoreVisibleStrokeParameters
}

type GeometrySnapshot = {
  scrollWidth: number
  scrollHeight: number
  targets: { x: number; y: number; width: number; height: number }[]
}

export type AppliedStrokeContrastLayer = {
  planHash: string
  document: Document
  targets: AppliedTarget[]
  spineIndex: number
  canvas: string
  restore: () => void
}

const appliedLayers = new WeakMap<Document, AppliedStrokeContrastLayer>()

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

export function isRestoreVisibleStrokeParameters(
  value: unknown,
): value is RestoreVisibleStrokeParameters {
  if (
    !isExactObject(value, [
      'schemaVersion',
      'sourceStroke',
      'targetStroke',
      'canvas',
      'surfaces',
      'minimumStrokeContrast',
      'observedSides',
      'strokes',
    ])
  ) {
    return false
  }
  return (
    value.schemaVersion === 2 &&
    typeof value.sourceStroke === 'string' &&
    HEX_COLOR.test(value.sourceStroke) &&
    typeof value.targetStroke === 'string' &&
    HEX_COLOR.test(value.targetStroke) &&
    typeof value.canvas === 'string' &&
    HEX_COLOR.test(value.canvas) &&
    Array.isArray(value.surfaces) &&
    value.surfaces.length > 0 &&
    value.surfaces.every(
      (surface) => typeof surface === 'string' && HEX_COLOR.test(surface),
    ) &&
    new Set(value.surfaces).size === value.surfaces.length &&
    typeof value.minimumStrokeContrast === 'number' &&
    Number.isFinite(value.minimumStrokeContrast) &&
    value.minimumStrokeContrast >= 1 &&
    value.minimumStrokeContrast <= 21 &&
    Number.isInteger(value.observedSides) &&
    (value.observedSides as number) > 0 &&
    Array.isArray(value.strokes) &&
    value.strokes.length === value.observedSides &&
    value.strokes.every(
      (stroke) =>
        isExactObject(stroke, ['sourcePath', 'side']) &&
        Array.isArray(stroke.sourcePath) &&
        stroke.sourcePath.every(
          (index) => Number.isInteger(index) && index >= 0,
        ) &&
        (stroke.side === 'top' ||
          stroke.side === 'right' ||
          stroke.side === 'bottom' ||
          stroke.side === 'left'),
    ) &&
    new Set(
      value.strokes.map(
        (stroke) => `${stroke.sourcePath.join('.')}:${stroke.side}`,
      ),
    ).size === value.strokes.length
  )
}

export const RESTORE_VISIBLE_STROKE_OPERATION_VALIDATORS: PresentationOperationValidators =
  {
    'restore-visible-stroke': (parameters, patch) =>
      isRestoreVisibleStrokeParameters(parameters) &&
      patch.operationVersion === RESTORE_VISIBLE_STROKE_OPERATION_VERSION &&
      patch.effects.paint === true &&
      patch.effects.geometry === 'none' &&
      patch.effects.semantics === 'none',
  }

const sideProperties: Record<
  PresentationStrokeSide,
  {
    color: StrokeColorProperty
    style: StrokeStyleProperty
    width: StrokeWidthProperty
  }
> = {
  top: {
    color: 'borderTopColor',
    style: 'borderTopStyle',
    width: 'borderTopWidth',
  },
  right: {
    color: 'borderRightColor',
    style: 'borderRightStyle',
    width: 'borderRightWidth',
  },
  bottom: {
    color: 'borderBottomColor',
    style: 'borderBottomStyle',
    width: 'borderBottomWidth',
  },
  left: {
    color: 'borderLeftColor',
    style: 'borderLeftStyle',
    width: 'borderLeftWidth',
  },
}

function strokeSamples(
  observation: PresentationHealthObservation,
): StrokeSample[] {
  if (
    observation.paint.kind !== 'known' ||
    observation.style.display === 'none' ||
    observation.style.visibility !== 'visible' ||
    observation.style.contentVisibility === 'hidden' ||
    observation.geometry.clientRectCount === 0 ||
    (observation.geometry.width <= 0 && observation.geometry.height <= 0)
  ) {
    return []
  }
  const samples: StrokeSample[] = []
  for (const side of Object.keys(sideProperties) as PresentationStrokeSide[]) {
    const properties = sideProperties[side]
    const borderStyle = observation.style[properties.style]
    const borderWidth = Number.parseFloat(observation.style[properties.width])
    const sideLength =
      side === 'top' || side === 'bottom'
        ? observation.geometry.width
        : observation.geometry.height
    if (
      typeof borderStyle !== 'string' ||
      !FLAT_BORDER_STYLES.has(borderStyle.toLowerCase()) ||
      !Number.isFinite(borderWidth) ||
      borderWidth <= 0 ||
      sideLength <= 0
    ) {
      continue
    }
    const colorValue = observation.style[properties.color]
    const color =
      typeof colorValue === 'string'
        ? resolveComputedSrgbColor(colorValue, observation.element)
        : undefined
    if (!color || color.a < 0.999) continue
    samples.push({
      observation,
      side,
      color,
      background: observation.paint.background,
      contrast: contrastRatio(color, observation.paint.background),
    })
  }
  return samples
}

function readableStroke(
  source: SrgbColor,
  backgrounds: readonly SrgbColor[],
  minimumContrast: number,
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
        (background) => contrastRatio(candidate, background) >= minimumContrast,
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
  const leftAncestors = new Set<Element>()
  let current: Element | null = left.element
  while (current) {
    leftAncestors.add(current)
    current = current.parentElement
  }
  current = right.element
  while (current) {
    if (leftAncestors.has(current)) return byElement.get(current) ?? left
    current = current.parentElement
  }
  return left
}

function reusableHealth(
  options: StrokeContrastAnalysisOptions,
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

export async function analyzeStrokeContrast(
  options: StrokeContrastAnalysisOptions,
): Promise<StrokeContrastAnalysis> {
  const canvas = parseSrgbColor(options.canvasColor)
  if (!canvas || canvas.a < 0.999) {
    return {
      findings: [],
      patches: [],
      inspectedElements: 0,
      candidateGroups: 0,
      truncatedGroups: 0,
      diagnostics: ['stroke-invalid-canvas'],
    }
  }
  const minimumStrokeContrast = boundedNumber(
    options.minimumStrokeContrast,
    3,
    1,
    21,
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
      inspectedElements: health.inspectedElements,
      candidateGroups: 0,
      truncatedGroups: 0,
      diagnostics: ['stroke-health-truncated'],
    }
  }

  const byElement = new WeakMap(
    health.observations.map((observation) => [
      observation.element,
      observation,
    ]),
  )
  const groups = new Map<string, CandidateGroup>()
  for (const observation of health.observations) {
    for (const sample of strokeSamples(observation)) {
      if (sample.contrast >= minimumStrokeContrast) continue
      const key = `${srgbToHex(sample.color)}:${srgbToHex(sample.background)}`
      const group = groups.get(key)
      if (!group) {
        groups.set(key, {
          root: observation,
          sourceStroke: sample.color,
          samples: [sample],
        })
      } else {
        group.root = commonObservedAncestor(group.root, observation, byElement)
        group.samples.push(sample)
      }
    }
  }

  const findings: PresentationFinding[] = []
  const patches: PresentationPatch[] = []
  let inspectedGroups = 0
  for (const group of groups.values()) {
    throwIfAborted(options.signal)
    if (patches.length >= maxCandidates) break
    inspectedGroups += 1
    const backgrounds = group.samples.map((sample) => sample.background)
    const targetStroke = readableStroke(
      group.sourceStroke,
      backgrounds,
      minimumStrokeContrast,
    )
    if (!targetStroke) continue
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
    }:${srgbToHex(group.sourceStroke).slice(1)}`
    const findingId = `stroke-contrast:${options.spineIndex}:${suffix}`
    const target = { source: group.root.address, sourceSignature }
    const parameters: RestoreVisibleStrokeParameters = {
      schemaVersion: 2,
      sourceStroke: srgbToHex(group.sourceStroke),
      targetStroke: srgbToHex(targetStroke),
      canvas: srgbToHex(canvas),
      surfaces,
      minimumStrokeContrast,
      observedSides: group.samples.length,
      strokes: group.samples
        .map((sample) => ({
          sourcePath: [...sample.observation.address.sourcePath],
          side: sample.side,
        }))
        .sort((left, right) => {
          const leftKey = `${left.sourcePath.join('.')}:${left.side}`
          const rightKey = `${right.sourcePath.join('.')}:${right.side}`
          return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0
        }),
    }
    findings.push({
      id: findingId,
      analyzerId: 'lumen.stroke.contrast',
      analyzerVersion: STROKE_CONTRAST_ANALYZER_VERSION,
      kind: 'visible-stroke-with-insufficient-contrast',
      confidence: 0.96,
      target,
      evidence: {
        sourceStroke: parameters.sourceStroke,
        surfaces,
        sourceContrast: Math.min(
          ...group.samples.map((sample) => sample.contrast),
        ),
        targetContrast: Math.min(
          ...backgrounds.map((background) =>
            contrastRatio(targetStroke, background),
          ),
        ),
        observedSides: parameters.observedSides,
      },
    })
    patches.push({
      id: `restore-visible-stroke:${options.spineIndex}:${suffix}`,
      operationVersion: RESTORE_VISIBLE_STROKE_OPERATION_VERSION,
      target,
      operation: 'restore-visible-stroke',
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
    inspectedElements: health.inspectedElements,
    candidateGroups: groups.size,
    truncatedGroups,
    diagnostics: truncatedGroups > 0 ? ['stroke-groups-truncated'] : [],
  }
}

function geometrySnapshot(
  document: Document,
  targets: readonly AppliedTarget[],
): GeometrySnapshot {
  const root = getSourceTreeRoot(document)
  return {
    scrollWidth: root.scrollWidth,
    scrollHeight: root.scrollHeight,
    targets: targets.flatMap((target) =>
      target.strokes.map(({ element }) => {
        const rect = element.getBoundingClientRect()
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
      }),
    ),
  }
}

function sameGeometry(
  left: GeometrySnapshot,
  right: GeometrySnapshot,
  epsilon = 0.5,
): boolean {
  const close = (a: number, b: number) => Math.abs(a - b) <= epsilon
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

function withinRoot(element: Element, root: Element): boolean {
  return element === root || root.contains(element)
}

function borderColorProperty(side: PresentationStrokeSide): string {
  return `border-${side}-color`
}

export async function applyRestoreVisibleStrokePlan(
  plan: PresentationPlan,
  sourceDocument: Document,
  renderedDocument: Document,
  expectedSpineIndex: number,
  signal?: AbortSignal,
): Promise<AppliedStrokeContrastLayer | undefined> {
  restoreStrokeContrastLayer(renderedDocument)
  const patches = plan.patches.filter(
    (patch) => patch.operation === 'restore-visible-stroke',
  )
  if (patches.length === 0) return undefined
  const targets: AppliedTarget[] = []
  const originalStyleAttributes = new Map<Element, string | null>()
  let restored = false
  const restore = (): void => {
    if (restored) return
    restored = true
    for (const target of [...targets].reverse()) {
      for (const stroke of [...target.strokes].reverse()) {
        stroke.override.restore()
      }
    }
    for (const [element, originalStyle] of originalStyleAttributes) {
      // Multiple side overrides share one style attribute. In real browsers,
      // restoring the last declaration can leave an empty attribute behind;
      // remove only that owned residue and never overwrite newer declarations.
      if (originalStyle === null && element.getAttribute('style') === '') {
        element.removeAttribute('style')
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
        patch.operationVersion !== RESTORE_VISIBLE_STROKE_OPERATION_VERSION ||
        patch.effects.paint !== true ||
        patch.effects.geometry !== 'none' ||
        patch.effects.semantics !== 'none' ||
        !isRestoreVisibleStrokeParameters(patch.parameters)
      ) {
        throw new TypeError('Unsupported visible-stroke operation')
      }
      if (canvas === undefined) canvas = patch.parameters.canvas
      else if (canvas !== patch.parameters.canvas) {
        throw new TypeError('Visible-stroke plan mixes rendering canvases')
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
        throw new Error('Visible-stroke source target is stale')
      }
      const signature = await createSourceNodeSignature(sourceNode)
      throwIfAborted(signal)
      if (!signature || signature !== patch.target.sourceSignature) {
        throw new Error('Visible-stroke source signature is stale')
      }
      targets.push({
        sourceRoot: sourceNode as Element,
        root: renderedNode as Element,
        strokes: [],
        parameters: patch.parameters,
      })
    }
    if (!canvas) throw new TypeError('Visible-stroke plan has no canvas')
    const health = createPresentationHealthMap({
      renderedDocument,
      spineIndex: expectedSpineIndex,
      canvasColor: canvas,
      signal,
      maxInspectedElements: MAX_PRESENTATION_HEALTH_ELEMENTS,
    })
    if (health.truncated) {
      throw new Error('Visible-stroke validation sample is truncated')
    }
    const owned = new WeakMap<Element, Set<PresentationStrokeSide>>()
    const byElement = new WeakMap(
      health.observations.map((observation) => [
        observation.element,
        observation,
      ]),
    )
    for (const target of targets) {
      const matches = target.parameters.strokes.map((strokeTarget) => {
        const address = {
          sourceModelVersion: SOURCE_TREE_MODEL_VERSION,
          spineIndex: expectedSpineIndex,
          nodeKind: 'element' as const,
          sourcePath: strokeTarget.sourcePath,
        }
        const sourceElement = resolveSourceTreeAddress(
          sourceDocument,
          address,
          expectedSpineIndex,
        )
        const renderedElement = resolveSourceTreeAddress(
          renderedDocument,
          address,
          expectedSpineIndex,
        )
        if (
          !sourceElement ||
          sourceElement.nodeType !== 1 ||
          !renderedElement ||
          renderedElement.nodeType !== 1 ||
          !withinRoot(sourceElement as Element, target.sourceRoot) ||
          !withinRoot(renderedElement as Element, target.root) ||
          (sourceElement as Element).localName !==
            (renderedElement as Element).localName
        ) {
          throw new Error('Visible-stroke sample target is stale')
        }
        const observation = byElement.get(renderedElement as Element)
        const sample = observation
          ? strokeSamples(observation).find(
              (candidate) => candidate.side === strokeTarget.side,
            )
          : undefined
        if (
          !sample ||
          sample.contrast >= target.parameters.minimumStrokeContrast ||
          srgbToHex(sample.color) !== target.parameters.sourceStroke ||
          !target.parameters.surfaces.includes(srgbToHex(sample.background))
        ) {
          throw new Error('Visible-stroke render evidence is stale')
        }
        return sample
      })
      if (matches.length !== target.parameters.observedSides) {
        throw new Error('Visible-stroke render evidence is stale')
      }
      for (const sample of matches) {
        const sides = owned.get(sample.observation.element) ?? new Set()
        if (sides.has(sample.side)) {
          throw new Error('Visible-stroke plan has overlapping targets')
        }
        sides.add(sample.side)
        owned.set(sample.observation.element, sides)
        if (!originalStyleAttributes.has(sample.observation.element)) {
          originalStyleAttributes.set(
            sample.observation.element,
            sample.observation.element.getAttribute('style'),
          )
        }
        target.strokes.push({
          element: sample.observation.element,
          side: sample.side,
          override: applyReversibleInlineStyle(
            sample.observation.element,
            borderColorProperty(sample.side),
            target.parameters.targetStroke,
          ),
        })
      }
    }
    const layer: AppliedStrokeContrastLayer = {
      planHash: plan.planHash,
      document: renderedDocument,
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

export function restoreStrokeContrastLayer(document: Document): void {
  appliedLayers.get(document)?.restore()
}

export function validateRestoredVisibleStrokes(
  layer: AppliedStrokeContrastLayer,
): { input: ValidationRecordInput } {
  const enabledGeometry = geometrySnapshot(layer.document, layer.targets)
  const overrides = layer.targets.flatMap((target) =>
    target.strokes.map((stroke) => stroke.override),
  )
  const resume = suspendInlineStyles(overrides)
  const publishedGeometry = geometrySnapshot(layer.document, layer.targets)
  resume()
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
    health.observations.map((observation) => [
      observation.element,
      observation,
    ]),
  )
  let samples = 0
  let repaired = 0
  for (const target of layer.targets) {
    for (const stroke of target.strokes) {
      samples += 1
      const observation = byElement.get(stroke.element)
      const sample = observation
        ? strokeSamples(observation).find(
            (candidate) => candidate.side === stroke.side,
          )
        : undefined
      if (
        sample &&
        srgbToHex(sample.color) === target.parameters.targetStroke &&
        sample.contrast >= target.parameters.minimumStrokeContrast
      ) {
        repaired += 1
      }
    }
  }
  const paintProven = !health.truncated && samples > 0 && repaired === samples
  const passed = paintProven && geometryStable
  const probes: ProbeResult[] = [
    {
      id: 'visible-stroke-contrast',
      probeVersion: STROKE_CONTRAST_VALIDATOR_VERSION,
      passed: paintProven,
      confidence: paintProven ? 0.96 : 0,
      metrics: { samples, repaired, truncated: health.truncated },
    },
  ]
  const failureReasons: ValidationFailure[] = []
  if (!paintProven) {
    failureReasons.push({
      code: 'visible-stroke-unresolved',
      findingIds: [],
      patchIds: [],
    })
  }
  if (!geometryStable) {
    failureReasons.push({
      code: 'visible-stroke-geometry-changed',
      findingIds: [],
      patchIds: [],
    })
  }
  const input: ValidationRecordInput = {
    validatorVersion: STROKE_CONTRAST_VALIDATOR_VERSION,
    passed,
    confidence: passed ? 0.96 : 1,
    probes,
    geometryStable,
    failureReasons,
  }
  canonicalJson(input)
  return { input }
}

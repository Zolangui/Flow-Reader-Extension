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
} from './source-tree'

export const EXPLICIT_FOREGROUND_ANALYZER_VERSION = 9 as const
export const RESTORE_EXPLICIT_TEXT_OPERATION_VERSION = 3 as const
export const EXPLICIT_FOREGROUND_VALIDATOR_VERSION = 5 as const

const LAYER_ATTRIBUTE = 'data-lumen-presentation-layer'
const TARGET_ATTRIBUTE = 'data-lumen-explicit-text-target'
const HEX_COLOR = /^#[0-9a-f]{6}$/

export type RestoreExplicitTextParameters = {
  schemaVersion: 2
  sourceText: string
  targetText: string
  canvas: string
  surfaces: string[]
  minimumTextContrast: number
  observedTextCodePoints: number
}

export type ExplicitForegroundAnalysisOptions = {
  sourceDocument: Document
  renderedDocument: Document
  spineIndex: number
  canvasColor: string
  signal?: AbortSignal
  minimumTextContrast?: number
  preferredTextContrast?: number
  maxCandidates?: number
  healthMap?: PresentationHealthMap
}

export type ExplicitForegroundAnalysis = {
  findings: PresentationFinding[]
  patches: PresentationPatch[]
  inspectedElements: number
  candidateGroups: number
  truncatedGroups: number
  diagnostics: string[]
}

type GeometrySnapshot = {
  scrollWidth: number
  scrollHeight: number
  targets: Array<{ width: number; height: number; x: number; y: number }>
}

type AppliedSample = {
  element: Element
  marker: string
  previousMarker: string | null
  colorOverride: ReversibleInlineStyleOverride
}

type AppliedTarget = {
  root: Element
  samples: AppliedSample[]
  parameters: RestoreExplicitTextParameters
}

export type AppliedExplicitForegroundLayer = {
  planHash: string
  document: Document
  style: HTMLStyleElement
  targets: AppliedTarget[]
  spineIndex: number
  canvas: string
  /** Published paint baseline for proving that inheritance stayed local. */
  publishedHealth: PresentationHealthMap
  restore: () => void
}

const appliedLayers = new WeakMap<Document, AppliedExplicitForegroundLayer>()

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

export function isRestoreExplicitTextParameters(
  value: unknown,
): value is RestoreExplicitTextParameters {
  if (
    !isExactObject(value, [
      'schemaVersion',
      'sourceText',
      'targetText',
      'canvas',
      'surfaces',
      'minimumTextContrast',
      'observedTextCodePoints',
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
    Number.isInteger(value.observedTextCodePoints) &&
    (value.observedTextCodePoints as number) > 0
  )
}

export const RESTORE_EXPLICIT_TEXT_OPERATION_VALIDATORS: PresentationOperationValidators =
  {
    'restore-explicit-text': (parameters, patch) =>
      isRestoreExplicitTextParameters(parameters) &&
      patch.operationVersion === RESTORE_EXPLICIT_TEXT_OPERATION_VERSION &&
      patch.effects.paint === true &&
      patch.effects.geometry === 'none' &&
      patch.effects.semantics === 'none',
  }

/**
 * Move only OKLCH lightness by the smallest amount that makes the authored
 * foreground readable against every proven surface. This works in both
 * directions while preserving hue and as much chroma as sRGB can represent.
 */
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

function colorHex(value: string, element: Element): string | undefined {
  const color = resolveComputedSrgbColor(value, element)
  return color && color.a >= 0.999 ? srgbToHex(color) : undefined
}

/**
 * Find the highest ancestor sharing the unreadable computed color. This may
 * be the source root: EPUBs frequently repeat the body's foreground on child
 * selectors, so a body-only inherited override cannot repair those explicit
 * descendants. The operation still marks only the proven low-contrast text
 * samples individually and therefore does not recolor unrelated accents.
 */
function localColorRoot(
  observation: PresentationHealthObservation,
  health: PresentationHealthMap,
): PresentationHealthObservation | undefined {
  const sourceText = colorHex(observation.style.color, observation.element)
  if (!sourceText) return undefined
  let current = observation
  while (current.parentObservationIndex !== undefined) {
    const parent = health.observations[current.parentObservationIndex]
    if (
      !parent ||
      colorHex(parent.style.color, parent.element) !== sourceText
    ) {
      break
    }
    current = parent
  }
  return current
}

function commonObservedAncestor(
  left: PresentationHealthObservation,
  right: PresentationHealthObservation,
  byElement: WeakMap<Element, PresentationHealthObservation>,
): PresentationHealthObservation {
  const leftAncestors = new WeakSet<Element>()
  let current: Element | null = left.element
  while (current) {
    leftAncestors.add(current)
    current = current.parentElement
  }
  current = right.element
  while (current) {
    if (leftAncestors.has(current)) {
      const observation = byElement.get(current)
      if (observation) return observation
    }
    current = current.parentElement
  }
  return left
}

export async function analyzeExplicitForegroundContrast(
  options: ExplicitForegroundAnalysisOptions,
): Promise<ExplicitForegroundAnalysis> {
  const canvas = parseSrgbColor(options.canvasColor)
  if (!canvas || canvas.a < 0.999) {
    return {
      findings: [],
      patches: [],
      inspectedElements: 0,
      candidateGroups: 0,
      truncatedGroups: 0,
      diagnostics: [],
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
  const maxCandidates = boundedInteger(options.maxCandidates, 8, 0, 16)
  const health =
    options.healthMap?.modelVersion === PRESENTATION_HEALTH_MODEL_VERSION &&
    options.healthMap.spineIndex === options.spineIndex &&
    options.healthMap.renderedDocument === options.renderedDocument &&
    options.healthMap.canvas !== undefined &&
    srgbToHex(options.healthMap.canvas) === srgbToHex(canvas) &&
    options.healthMap.observations.every(
      (observation) =>
        observation.element.ownerDocument === options.renderedDocument,
    )
      ? options.healthMap
      : createPresentationHealthMap({
          renderedDocument: options.renderedDocument,
          spineIndex: options.spineIndex,
          canvasColor: canvas,
          signal: options.signal,
          maxInspectedElements: MAX_PRESENTATION_HEALTH_ELEMENTS,
        })

  // A local-looking candidate discovered in a prefix can still have a much
  // wider inheritance root. Application and validation require complete
  // collateral evidence, so emitting a doomed prefix-only plan only turns a
  // safe no-finding into a fatal before-pagination fallback.
  if (health.truncated) {
    return {
      findings: [],
      patches: [],
      inspectedElements: health.inspectedElements,
      candidateGroups: 0,
      truncatedGroups: 0,
      diagnostics: ['explicit-health-truncated'],
    }
  }

  const eligible = health.observations.filter((observation) => {
    if (
      !observation.textPaintEligible ||
      observation.paint.kind !== 'known' ||
      observation.paint.contrast >= minimumTextContrast
    ) {
      return false
    }
    const foreground = resolveComputedSrgbColor(
      observation.style.color,
      observation.element,
    )
    if (!foreground || foreground.a < 0.999) return false
    // Saturation and direction are not legibility boundaries. Once
    // foreground, surface and insufficient contrast are proven, adjust only
    // lightness while preserving authored hue/chroma.
    return true
  })

  type CandidateGroup = {
    root: PresentationHealthObservation
    sourceText: SrgbColor
    samples: PresentationHealthObservation[]
  }
  const localGroups = new Map<string, CandidateGroup>()
  for (const observation of eligible) {
    const root = localColorRoot(observation, health)
    const sourceText = resolveComputedSrgbColor(
      observation.style.color,
      observation.element,
    )
    if (!root || !sourceText) continue
    const key = `${root.address.sourcePath.join('.')}:${srgbToHex(sourceText)}`
    const group = localGroups.get(key) ?? { root, sourceText, samples: [] }
    group.samples.push(observation)
    localGroups.set(key, group)
  }

  // A TOC or index can contain thousands of independent anchors that all
  // resolve to the same host blue over the same reader canvas. They are one
  // paint decision, not thousands of candidates. Coalesce only identical
  // source colours and identical proven surface sets; application still marks
  // each low-contrast glyph owner and validation still checks every sample.
  const observationsByElement = new WeakMap(
    health.observations.map((observation) => [
      observation.element,
      observation,
    ]),
  )
  const groups = new Map<string, CandidateGroup>()
  for (const local of localGroups.values()) {
    const surfaces = [
      ...new Set(
        local.samples.flatMap((sample) =>
          sample.paint.kind === 'known'
            ? [srgbToHex(sample.paint.background)]
            : [],
        ),
      ),
    ].sort()
    const key = `${srgbToHex(local.sourceText)}:${surfaces.join(',')}`
    const existing = groups.get(key)
    if (!existing) {
      groups.set(key, local)
      continue
    }
    existing.root = commonObservedAncestor(
      existing.root,
      local.root,
      observationsByElement,
    )
    existing.samples.push(...local.samples)
  }

  const findings: PresentationFinding[] = []
  const patches: PresentationPatch[] = []
  let inspectedGroups = 0
  for (const group of groups.values()) {
    throwIfAborted(options.signal)
    if (patches.length >= maxCandidates) break
    inspectedGroups += 1
    const observedTextCodePoints = group.samples.reduce(
      (total, sample) => total + sample.directTextCodePoints,
      0,
    )
    // Complete paint evidence, a stable source address and post-application
    // validation are the safety boundaries. Text length is not: a short title
    // or publisher label can be the only unreadable text on a page.
    const backgrounds = group.samples.flatMap((sample) =>
      sample.paint.kind === 'known' ? [sample.paint.background] : [],
    )
    // Neutral prose benefits from the preferred 7:1 target. Highly chromatic
    // author accents move only as far as the mandatory threshold so the
    // repair preserves more of the publication's original palette.
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
    if (
      !sourceNode ||
      sourceNode.nodeType !== 1 ||
      (sourceNode as Element).localName !== group.root.localName
    ) {
      continue
    }
    const sourceSignature = await createSourceNodeSignature(sourceNode)
    throwIfAborted(options.signal)
    if (!sourceSignature) continue

    const sourceColorSuffix = srgbToHex(group.sourceText).slice(1)
    const suffix = `${
      group.root.address.sourcePath.join('.') || 'root'
    }:${sourceColorSuffix}`
    const findingId = `explicit-foreground:${options.spineIndex}:${suffix}`
    const target = { source: group.root.address, sourceSignature }
    const surfaces = [
      ...new Set(backgrounds.map((background) => srgbToHex(background))),
    ].sort()
    const parameters: RestoreExplicitTextParameters = {
      schemaVersion: 2,
      sourceText: srgbToHex(group.sourceText),
      targetText: srgbToHex(targetText),
      canvas: srgbToHex(canvas),
      surfaces,
      minimumTextContrast,
      observedTextCodePoints,
    }
    findings.push({
      id: findingId,
      analyzerId: 'lumen.explicit-foreground.contrast',
      analyzerVersion: EXPLICIT_FOREGROUND_ANALYZER_VERSION,
      kind: 'explicit-text-with-insufficient-contrast',
      confidence: 0.97,
      target,
      evidence: {
        sourceText: parameters.sourceText,
        surfaces,
        sourceContrast: Math.min(
          ...group.samples.flatMap((sample) =>
            sample.paint.kind === 'known' ? [sample.paint.contrast] : [],
          ),
        ),
        targetContrast: Math.min(
          ...backgrounds.map((background) =>
            contrastRatio(targetText, background),
          ),
        ),
        observedSamples: group.samples.length,
        observedTextCodePoints,
      },
    })
    patches.push({
      id: `restore-explicit-text:${options.spineIndex}:${suffix}`,
      operationVersion: RESTORE_EXPLICIT_TEXT_OPERATION_VERSION,
      target,
      operation: 'restore-explicit-text',
      parameters: parameters as unknown as {
        [key: string]: CanonicalJsonValue
      },
      reasonFindingIds: [findingId],
      confidence: 0.97,
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
    diagnostics: truncatedGroups > 0 ? ['explicit-groups-truncated'] : [],
  }
}

/** @deprecated Use the scheme-neutral contrast analyzer. */
export const analyzeExplicitForegroundForDarkTheme =
  analyzeExplicitForegroundContrast

function geometrySnapshot(
  document: Document,
  targets: readonly AppliedTarget[],
): GeometrySnapshot {
  const root = getSourceTreeRoot(document)
  return {
    scrollWidth: root.scrollWidth,
    scrollHeight: root.scrollHeight,
    targets: targets.flatMap(({ samples }) =>
      samples.map(({ element }) => {
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

export async function applyRestoreExplicitTextPlan(
  plan: PresentationPlan,
  sourceDocument: Document,
  renderedDocument: Document,
  expectedSpineIndex: number,
  signal?: AbortSignal,
): Promise<AppliedExplicitForegroundLayer | undefined> {
  restoreExplicitForegroundLayer(renderedDocument)
  const patches = plan.patches.filter(
    (patch) => patch.operation === 'restore-explicit-text',
  )
  if (patches.length === 0) return undefined
  const targets: AppliedTarget[] = []
  let style: HTMLStyleElement | undefined
  let restored = false
  const restore = (): void => {
    if (restored) return
    restored = true
    style?.remove()
    for (const target of targets) {
      for (const sample of [...target.samples].reverse()) {
        sample.colorOverride.restore()
        if (sample.previousMarker === null) {
          sample.element.removeAttribute(TARGET_ATTRIBUTE)
        } else {
          sample.element.setAttribute(TARGET_ATTRIBUTE, sample.previousMarker)
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
        patch.operationVersion !== RESTORE_EXPLICIT_TEXT_OPERATION_VERSION ||
        patch.effects.paint !== true ||
        patch.effects.geometry !== 'none' ||
        patch.effects.semantics !== 'none' ||
        !isRestoreExplicitTextParameters(patch.parameters)
      ) {
        throw new TypeError('Unsupported explicit-text operation')
      }
      if (canvas === undefined) canvas = patch.parameters.canvas
      else if (patch.parameters.canvas !== canvas) {
        throw new TypeError('Explicit-text plan mixes rendering canvases')
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
        throw new Error('Explicit-text source target is stale')
      }
      const signature = await createSourceNodeSignature(sourceNode)
      throwIfAborted(signal)
      if (!signature || signature !== patch.target.sourceSignature) {
        throw new Error('Explicit-text source signature is stale')
      }
      targets.push({
        root: renderedNode as Element,
        samples: [],
        parameters: patch.parameters,
      })
    }
    if (!canvas) throw new TypeError('Explicit-text plan has no canvas')

    // One unpredictable base proves the whole layer cannot collide with an
    // authored deterministic marker. Per-sample suffixes are unique within
    // this application and avoid a full-document selector scan per glyph
    // owner on large chapters.
    const markerBase = createPresentationRuntimeMarker(
      renderedDocument,
      'explicit-text',
      TARGET_ATTRIBUTE,
    )

    const health = createPresentationHealthMap({
      renderedDocument,
      spineIndex: expectedSpineIndex,
      canvasColor: canvas,
      signal,
      maxInspectedElements: MAX_PRESENTATION_HEALTH_ELEMENTS,
    })
    if (health.truncated) {
      throw new Error('Explicit-text validation sample is truncated')
    }
    for (const [targetIndex, target] of targets.entries()) {
      const samples = health.observations.filter((observation) => {
        if (
          !observation.directMeaningfulText ||
          !observation.textPaintEligible ||
          observation.paint.kind !== 'known' ||
          observation.paint.contrast >= target.parameters.minimumTextContrast ||
          colorHex(observation.style.color, observation.element) !==
            target.parameters.sourceText
        ) {
          return false
        }
        return (
          observation.element === target.root ||
          target.root.contains(observation.element)
        )
      })
      const observedTextCodePoints = samples.reduce(
        (total, sample) => total + sample.directTextCodePoints,
        0,
      )
      if (
        samples.length === 0 ||
        observedTextCodePoints !== target.parameters.observedTextCodePoints
      ) {
        throw new Error('Explicit-text render evidence is stale')
      }
      for (const [sampleIndex, observation] of samples.entries()) {
        const marker = `${markerBase}-${targetIndex}-${sampleIndex}`
        const previousMarker =
          observation.element.getAttribute(TARGET_ATTRIBUTE)
        const colorOverride = applyReversibleInlineStyle(
          observation.element,
          'color',
          target.parameters.targetText,
        )
        observation.element.setAttribute(TARGET_ATTRIBUTE, marker)
        target.samples.push({
          element: observation.element,
          marker,
          previousMarker,
          colorOverride,
        })
      }
    }
    style = renderedDocument.createElementNS(
      'http://www.w3.org/1999/xhtml',
      'style',
    ) as HTMLStyleElement
    markPresentationRuntimeNode(style)
    // Keep a runtime-owned layer marker for lifecycle diagnostics. Paint is
    // applied inline because selector specificity cannot safely outrank every
    // authored or host `!important` rule.
    style.setAttribute(LAYER_ATTRIBUTE, 'explicit-text-v3')
    ;(renderedDocument.head ?? renderedDocument.documentElement).appendChild(
      style,
    )
    const layer: AppliedExplicitForegroundLayer = {
      planHash: plan.planHash,
      document: renderedDocument,
      style,
      targets,
      spineIndex: expectedSpineIndex,
      canvas,
      publishedHealth: health,
      restore,
    }
    appliedLayers.set(renderedDocument, layer)
    return layer
  } catch (error) {
    restore()
    throw error
  }
}

export function restoreExplicitForegroundLayer(document: Document): void {
  appliedLayers.get(document)?.restore()
}

export function validateRestoredExplicitText(
  layer: AppliedExplicitForegroundLayer,
): { input: ValidationRecordInput } {
  if (!layer.style.isConnected) {
    throw new Error('Explicit-text layer marker is unavailable')
  }
  const enabledGeometry = geometrySnapshot(layer.document, layer.targets)
  let publishedGeometry: GeometrySnapshot
  const resume = suspendInlineStyles(
    layer.targets.flatMap((target) =>
      target.samples.map((sample) => sample.colorOverride),
    ),
  )
  try {
    // Compare both paint states inside the same final pagination. The old
    // baseline was captured before Layout.format(), so every real browser
    // reported a false geometry change even for a color-only declaration.
    publishedGeometry = geometrySnapshot(layer.document, layer.targets)
  } finally {
    resume()
  }
  const restoredGeometry = geometrySnapshot(layer.document, layer.targets)
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
  let repaired = 0
  let samples = 0
  const intendedElements = new WeakSet<Element>()
  for (const target of layer.targets) {
    for (const sample of target.samples) {
      intendedElements.add(sample.element)
      samples += 1
      const observation = byElement.get(sample.element)
      if (
        observation?.paint.kind === 'known' &&
        colorHex(observation.style.color, observation.element) ===
          target.parameters.targetText &&
        target.parameters.surfaces.includes(
          srgbToHex(observation.paint.background),
        ) &&
        observation.paint.contrast >= target.parameters.minimumTextContrast
      ) {
        repaired += 1
      }
    }
  }
  let collateralColorChanges = 0
  for (const before of layer.publishedHealth.observations) {
    if (
      !before.directMeaningfulText ||
      intendedElements.has(before.element) ||
      before.style.display === 'none' ||
      before.style.visibility !== 'visible' ||
      before.style.contentVisibility === 'hidden' ||
      before.geometry.clientRectCount === 0
    ) {
      continue
    }
    const after = byElement.get(before.element)
    if (!after || before.style.color !== after.style.color) {
      collateralColorChanges += 1
    }
  }
  const geometryStable =
    sameGeometry(enabledGeometry, publishedGeometry) &&
    sameGeometry(enabledGeometry, restoredGeometry)
  const paintProven =
    !health.truncated &&
    !layer.publishedHealth.truncated &&
    samples > 0 &&
    repaired === samples &&
    collateralColorChanges === 0
  const passed = paintProven && geometryStable
  const probes: ProbeResult[] = [
    {
      id: 'explicit-text-contrast',
      probeVersion: EXPLICIT_FOREGROUND_VALIDATOR_VERSION,
      passed: paintProven,
      confidence: paintProven ? 0.97 : 0,
      metrics: {
        repaired,
        samples,
        targetGroups: layer.targets.length,
        truncated: health.truncated,
        collateralColorChanges,
      },
    },
  ]
  const failures: ValidationFailure[] = []
  if (!paintProven) {
    failures.push({
      code: 'explicit-text-unresolved',
      findingIds: [],
      patchIds: [],
    })
  }
  if (!geometryStable) {
    failures.push({
      code: 'explicit-text-geometry-changed',
      findingIds: [],
      patchIds: [],
    })
  }
  const input: ValidationRecordInput = {
    validatorVersion: EXPLICIT_FOREGROUND_VALIDATOR_VERSION,
    passed,
    confidence: passed ? 0.97 : 1,
    probes,
    geometryStable,
    failureReasons: failures,
  }
  canonicalJson(input)
  return { input }
}

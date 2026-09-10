import { canonicalJson } from './canonical-json'
import type Contents from './contents'
import { sectionLayoutName } from './layout'
import type IframeView from './managers/views/iframe'
import type {
  PaginationLifecycle,
  PaginationLifecycleArtifacts,
  PaginationLifecycleContext,
} from './pagination-lifecycle'
import {
  PAGINATION_ARTIFACTS_VERSION,
  recordPaginationGeometryArtifact,
} from './pagination-lifecycle'
import {
  ACTIVATE_AUTHOR_THEME_OPERATION_VERSION,
  analyzeAuthorTheme,
  applyAuthorThemePlan,
  AUTHOR_THEME_OPERATION_VALIDATORS,
  AUTHOR_THEME_RESOLVER_VERSION,
  AUTHOR_THEME_VALIDATOR_VERSION,
  restoreAuthorThemeLayer,
  validateAppliedAuthorTheme,
  waitForAuthorThemeGeometryStability,
  type AppliedAuthorThemeLayer,
} from './presentation-author-theme'
import {
  PRESENTATION_COLOR_MODEL_VERSION,
  parseSrgbColor,
  srgbToHex,
} from './presentation-color'
import {
  analyzeExplicitForegroundContrast,
  applyRestoreExplicitTextPlan,
  EXPLICIT_FOREGROUND_ANALYZER_VERSION,
  RESTORE_EXPLICIT_TEXT_OPERATION_VALIDATORS,
  restoreExplicitForegroundLayer,
  validateRestoredExplicitText,
  type AppliedExplicitForegroundLayer,
} from './presentation-explicit-foreground'
import {
  analyzeInheritedForegroundForDarkTheme,
  applyRestoreVisibleTextPlan,
  INHERITED_FOREGROUND_ANALYZER_VERSION,
  RESTORE_VISIBLE_TEXT_OPERATION_VALIDATORS,
  restoreInheritedForegroundLayer,
  validateRestoredVisibleText,
  type AppliedInheritedForegroundLayer,
  type InheritedForegroundRuntimeEvidence,
} from './presentation-foreground'
import {
  analyzeWideTableOverflow,
  applyContainOverflowPlan,
  CONTAIN_OVERFLOW_OPERATION_VALIDATORS,
  CONTAIN_OVERFLOW_OPERATION_VERSION,
  CONTAIN_OVERFLOW_VALIDATOR_VERSION,
  restoreGeometryPresentationLayer,
  validateContainedOverflowPlan,
  waitForOverflowGeometryStability,
  WIDE_TABLE_ANALYZER_VERSION,
  type AppliedOverflowLayer,
} from './presentation-geometry'
import {
  createPresentationHealthMap,
  MAX_PRESENTATION_HEALTH_ELEMENTS,
  PRESENTATION_HEALTH_MODEL_VERSION,
  PRESENTATION_LEGIBILITY_MODEL_VERSION,
  summarizePresentationLegibility,
  type PresentationLegibilitySummary,
} from './presentation-health'
import {
  analyzeListMarkerContrast,
  applyRestoreListMarkerPlan,
  LIST_MARKER_ANALYZER_VERSION,
  RESTORE_LIST_MARKER_OPERATION_VALIDATORS,
  restoreListMarkerLayer,
  validateRestoredListMarkers,
  type AppliedListMarkerLayer,
} from './presentation-list-marker'
import {
  analyzeOpaquePaletteForDarkTheme,
  applyRemapPalettePlan,
  OPAQUE_PALETTE_ANALYZER_VERSION,
  REMAP_PALETTE_OPERATION_VALIDATORS,
  restorePresentationLayer,
  validateAppliedPalettePlan,
  type AppliedPresentationLayer,
} from './presentation-palette'
import {
  admitPresentationPlan,
  createPresentationPlan,
  createValidationRecord,
  PRESENTATION_PLAN_SCHEMA_VERSION,
  type AcceptedPresentationPlan,
  type PresentationFinding,
  type PresentationMode,
  type PresentationPatch,
  type PresentationPlan,
  type ValidationRecord,
  type ValidationRecordInput,
} from './presentation-plan'
import {
  DEFAULT_PRESENTATION_RUN_BUDGET,
  PresentationRun,
  PresentationRunBudgetError,
  PresentationRunCancelledError,
  PresentationRunCoordinator,
  type PresentationRunBudget,
} from './presentation-run'
import {
  analyzeStrokeContrast,
  applyRestoreVisibleStrokePlan,
  RESTORE_VISIBLE_STROKE_OPERATION_VALIDATORS,
  restoreStrokeContrastLayer,
  STROKE_CONTRAST_ANALYZER_VERSION,
  validateRestoredVisibleStrokes,
  type AppliedStrokeContrastLayer,
} from './presentation-stroke'
import {
  SOURCE_SIGNATURE_VERSION,
  SOURCE_TREE_MODEL_VERSION,
} from './source-tree'
import type { RequestFunction } from './types'
import type Hook from './utils/hook'

export const LUMEN_PRESENTATION_ENGINE_VERSION = 'lpe-v1-phase7.18' as const
export const LUMEN_PRESENTATION_GEOMETRY_PRODUCER_ID =
  'lumen-presentation-engine' as const
/** Bump only when geometry-producing semantics change; paint must not. */
export const LUMEN_PRESENTATION_GEOMETRY_PIPELINE_VERSION =
  'lpe-geometry-v6' as const
/** Production adoption remains opt-in until the cross-browser corpus passes. */
export const DEFAULT_ADAPTIVE_PRESENTATION_ENABLED = false as const

export type LumenPresentationPolicy = {
  /** Adaptive remains opt-in while the cross-browser fixture corpus grows. */
  enabled: boolean
  mode: PresentationMode
  colorScheme: 'light' | 'dark'
  canvasColor: string
  publicationRevision: string
  analysisFingerprint: string
  renderingContextFingerprint: string
  minimumTextContrast?: number
}

export type LumenPresentationOutcome = {
  status:
    | 'adapted'
    | 'published-disabled'
    | 'published-readable'
    | 'published-unproven'
    | 'published-fallback'
    | 'cancelled'
  purpose: PaginationLifecycleContext['purpose']
  spineIndex: number
  plan?: PresentationPlan
  validation?: ValidationRecord
  accepted?: AcceptedPresentationPlan
  reason?: string
  /** Wall-clock time spent in this Adaptive run, for test-build diagnostics. */
  elapsedMs?: number
  legibility?: PresentationLegibilitySummary
  diagnostics: readonly { code: string; state: string }[]
}

export type LumenPresentationEngineOptions = {
  resolvePolicy: (
    context: PaginationLifecycleContext,
    signal?: AbortSignal,
  ) => LumenPresentationPolicy | Promise<LumenPresentationPolicy>
  request?: RequestFunction
  budget?: Partial<PresentationRunBudget>
  onOutcome?: (outcome: LumenPresentationOutcome) => void
  /**
   * Stable identity of every policy/configuration input capable of selecting
   * a different geometry-affecting operation. A paint value belongs here when
   * it participates in admission of an authored theme that can also reflow.
   */
  resolveGeometryPipelineFingerprint: () => string
}

type RenditionPresentationHost = {
  book: {
    load: RequestFunction
  }
  hooks: {
    beforePagination: Hook
    afterPagination: Hook
  }
  getContents(): Contents[]
  views?():
    | IframeView[]
    | {
        forEach(callback: (view: IframeView) => void): void
      }
  registerPaginationGeometryPipeline(
    producerId: string,
    resolveFingerprint: () => string,
  ): () => void
}

export type LumenPresentationCandidate = {
  run: PresentationRun
  coordinator: PresentationRunCoordinator
  policy: LumenPresentationPolicy
  sourceDocument: Document
  view: IframeView
  artifacts: PaginationLifecycleArtifacts
  renderedDocument: Document
  fallbackAnalysis?: {
    findings: PresentationFinding[]
    patches: PresentationPatch[]
  }
  foregroundRuntimeEvidence?: InheritedForegroundRuntimeEvidence
  plan?: PresentationPlan
  authorThemeLayer?: AppliedAuthorThemeLayer
  foregroundLayer?: AppliedInheritedForegroundLayer
  explicitForegroundLayer?: AppliedExplicitForegroundLayer
  listMarkerLayer?: AppliedListMarkerLayer
  strokeLayer?: AppliedStrokeContrastLayer
  paletteLayer?: AppliedPresentationLayer
  geometryLayer?: AppliedOverflowLayer
  releaseAbort: () => void
}

const PRESENTATION_OPERATION_VALIDATORS = {
  ...AUTHOR_THEME_OPERATION_VALIDATORS,
  ...RESTORE_VISIBLE_TEXT_OPERATION_VALIDATORS,
  ...RESTORE_EXPLICIT_TEXT_OPERATION_VALIDATORS,
  ...RESTORE_LIST_MARKER_OPERATION_VALIDATORS,
  ...RESTORE_VISIBLE_STROKE_OPERATION_VALIDATORS,
  ...REMAP_PALETTE_OPERATION_VALIDATORS,
  ...CONTAIN_OVERFLOW_OPERATION_VALIDATORS,
}

function isAbort(error: unknown): boolean {
  return (error as { name?: string } | undefined)?.name === 'AbortError'
}

function isBudgetError(error: unknown): error is PresentationRunBudgetError {
  return error instanceof PresentationRunBudgetError
}

function withDeadline<T>(
  operation: PromiseLike<T> | T,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<T> {
  const execution = Promise.resolve(operation)
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const timeout = globalThis.setTimeout(() => {
      if (settled) return
      settled = true
      cleanup()
      reject(new PresentationRunBudgetError('maxElapsedMs'))
    }, Math.max(0, timeoutMs))
    const onAbort = (): void => {
      if (settled) return
      settled = true
      cleanup()
      reject(signal?.reason ?? new PresentationRunCancelledError())
    }
    const cleanup = (): void => {
      globalThis.clearTimeout(timeout)
      signal?.removeEventListener('abort', onAbort)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) {
      onAbort()
      return
    }
    execution.then(
      (value) => {
        if (settled) return
        settled = true
        cleanup()
        resolve(value)
      },
      (error: unknown) => {
        if (settled) return
        settled = true
        cleanup()
        reject(error)
      },
    )
  })
}

function diagnostics(
  run: PresentationRun,
): Array<{ code: string; state: string }> {
  return run.diagnostics.map(({ code, state }) => ({ code, state }))
}

function combineValidationInputs(
  inputs: readonly ValidationRecordInput[],
): ValidationRecordInput {
  if (inputs.length === 0) {
    throw new TypeError('Presentation validation requires at least one probe')
  }
  if (inputs.length === 1) return inputs[0]!
  const probes = inputs.flatMap((input) => input.probes)
  const failureReasons = inputs.flatMap((input) => input.failureReasons)
  const passed =
    inputs.every((input) => input.passed && input.geometryStable) &&
    probes.every((probe) => probe.passed) &&
    failureReasons.length === 0
  return {
    validatorVersion: 1,
    passed,
    confidence: passed
      ? Math.min(...inputs.map((input) => input.confidence))
      : 1,
    probes,
    geometryStable: inputs.every((input) => input.geometryStable),
    failureReasons,
  }
}

function normalizePolicy(
  policy: LumenPresentationPolicy,
): LumenPresentationPolicy {
  const canvas = parseSrgbColor(policy.canvasColor)
  const requestedContrast = policy.minimumTextContrast
  const minimumTextContrast =
    typeof requestedContrast === 'number' &&
    Number.isFinite(requestedContrast) &&
    requestedContrast >= 1 &&
    requestedContrast <= 21
      ? requestedContrast
      : 4.5
  if (policy.colorScheme === 'dark' && (!canvas || canvas.a < 0.999)) {
    return { ...policy, enabled: false }
  }
  return {
    ...policy,
    canvasColor: canvas ? srgbToHex(canvas) : policy.canvasColor,
    minimumTextContrast,
  }
}

/**
 * Phase-5 Presentation Engine runner.
 *
 * Adaptive remains opt-in. The bounded catalogue contains the opaque-palette
 * slice and one post-pagination wide-table containment operation.
 */
export class LumenPresentationEngine {
  private readonly coordinators = new WeakMap<
    IframeView,
    PresentationRunCoordinator
  >()
  private readonly active = new WeakMap<
    IframeView,
    LumenPresentationCandidate
  >()
  private readonly activeByArtifacts = new WeakMap<
    PaginationLifecycleArtifacts,
    LumenPresentationCandidate
  >()
  private readonly candidates = new Set<LumenPresentationCandidate>()
  private readonly runs = new Set<PresentationRun>()
  private attached = false
  private lifecycleEpoch = 0
  private releaseGeometryPipeline: (() => void) | undefined

  private readonly beforeHook = async (
    context: PaginationLifecycleContext,
    signal?: AbortSignal,
  ): Promise<LumenPresentationCandidate | undefined> => {
    return this.beforePagination(context, signal)
  }

  private readonly afterHook = async (
    context: PaginationLifecycleContext,
    candidate: unknown,
    signal?: AbortSignal,
  ): Promise<void> => {
    await this.afterPagination(
      context,
      signal,
      candidate as LumenPresentationCandidate | undefined,
    )
  }

  private readonly geometryPipelineFingerprint = (): string =>
    canonicalJson({
      producerId: LUMEN_PRESENTATION_GEOMETRY_PRODUCER_ID,
      geometryPipelineVersion: LUMEN_PRESENTATION_GEOMETRY_PIPELINE_VERSION,
      sourceTreeModelVersion: SOURCE_TREE_MODEL_VERSION,
      sourceSignatureVersion: SOURCE_SIGNATURE_VERSION,
      presentationHealthModelVersion: PRESENTATION_HEALTH_MODEL_VERSION,
      presentationColorModelVersion: PRESENTATION_COLOR_MODEL_VERSION,
      authorThemeResolverVersion: AUTHOR_THEME_RESOLVER_VERSION,
      activateAuthorThemeOperationVersion:
        ACTIVATE_AUTHOR_THEME_OPERATION_VERSION,
      authorThemeValidatorVersion: AUTHOR_THEME_VALIDATOR_VERSION,
      wideTableAnalyzerVersion: WIDE_TABLE_ANALYZER_VERSION,
      containOverflowOperationVersion: CONTAIN_OVERFLOW_OPERATION_VERSION,
      containOverflowValidatorVersion: CONTAIN_OVERFLOW_VALIDATOR_VERSION,
      hostConfiguration: this.options.resolveGeometryPipelineFingerprint(),
    })

  constructor(
    private readonly rendition: RenditionPresentationHost,
    private readonly options: LumenPresentationEngineOptions,
  ) {}

  /** Attach once; detached Atlas sessions receive these same Rendition hooks. */
  attach(): this {
    if (this.attached) return this
    this.lifecycleEpoch += 1
    this.releaseGeometryPipeline =
      this.rendition.registerPaginationGeometryPipeline(
        LUMEN_PRESENTATION_GEOMETRY_PRODUCER_ID,
        this.geometryPipelineFingerprint,
      )
    this.rendition.hooks.beforePagination.register(this.beforeHook)
    this.rendition.hooks.afterPagination.register(this.afterHook)
    this.attached = true
    return this
  }

  detach(): void {
    this.lifecycleEpoch += 1
    if (this.attached) {
      this.rendition.hooks.beforePagination.deregister(this.beforeHook)
      this.rendition.hooks.afterPagination.deregister(this.afterHook)
      this.attached = false
    }
    this.releaseGeometryPipeline?.()
    this.releaseGeometryPipeline = undefined
    // Preserve the geometry fact before cancelling runs. Cancellation invokes
    // each candidate's abort listener synchronously, which restores and
    // forgets the layer before the cleanup loop below can inspect it.
    const repaginate = new Set<IframeView>()
    this.candidates.forEach((candidate) => {
      if (candidate.authorThemeLayer || candidate.geometryLayer) {
        repaginate.add(candidate.view)
      }
    })
    this.runs.forEach((run) => run.cancel('presentation-engine-detached'))
    this.runs.clear()
    ;[...this.candidates].forEach((candidate) => {
      if (candidate.authorThemeLayer || candidate.geometryLayer) {
        repaginate.add(candidate.view)
      }
      candidate.releaseAbort()
      candidate.geometryLayer?.restore()
      candidate.paletteLayer?.restore()
      candidate.listMarkerLayer?.restore()
      candidate.strokeLayer?.restore()
      candidate.explicitForegroundLayer?.restore()
      candidate.foregroundLayer?.restore()
      candidate.authorThemeLayer?.restore()
      this.forgetCandidate(candidate)
      candidate.coordinator.release(candidate.run)
    })
    this.rendition.views?.().forEach((view) => {
      const document = view.contents?.document
      if (!document) return
      const restoredOverflowGeometry =
        restoreGeometryPresentationLayer(document)
      restorePresentationLayer(document)
      restoreListMarkerLayer(document)
      restoreStrokeContrastLayer(document)
      restoreExplicitForegroundLayer(document)
      restoreInheritedForegroundLayer(document)
      const restoredAuthorGeometry = restoreAuthorThemeLayer(document)
      if (restoredAuthorGeometry || restoredOverflowGeometry) {
        repaginate.add(view)
      }
    })
    this.rendition.getContents().forEach((contents) => {
      restoreGeometryPresentationLayer(contents.document)
      restorePresentationLayer(contents.document)
      restoreListMarkerLayer(contents.document)
      restoreStrokeContrastLayer(contents.document)
      restoreExplicitForegroundLayer(contents.document)
      restoreInheritedForegroundLayer(contents.document)
      restoreAuthorThemeLayer(contents.document)
    })
    repaginate.forEach((view) => {
      if (!view.contents || view._disposed) return
      try {
        view.layout.format(view.contents, view.section, view.axis)
        view.expand(true)
      } catch {
        // Detach is a best-effort synchronous teardown boundary. A view may be
        // disappearing concurrently; its own disposal will release the DOM.
      }
    })
  }

  /** Exposed for an isolated manager or fixture without a Rendition host. */
  getLifecycle(): PaginationLifecycle<
    LumenPresentationCandidate | undefined,
    ValidationRecord | undefined
  > {
    return {
      geometryProducerIds: () => [LUMEN_PRESENTATION_GEOMETRY_PRODUCER_ID],
      geometryPipelineFingerprint: this.geometryPipelineFingerprint,
      beforePagination: (context, signal) =>
        this.beforePagination(context, signal),
      afterPagination: (context, candidate, signal) =>
        this.afterPagination(context, signal, candidate),
    }
  }

  private coordinator(view: IframeView): PresentationRunCoordinator {
    let coordinator = this.coordinators.get(view)
    if (!coordinator) {
      coordinator = new PresentationRunCoordinator()
      this.coordinators.set(view, coordinator)
    }
    return coordinator
  }

  private rememberCandidate(
    context: PaginationLifecycleContext,
    candidate: LumenPresentationCandidate,
  ): LumenPresentationCandidate {
    this.active.set(context.view, candidate)
    this.activeByArtifacts.set(context.artifacts, candidate)
    this.candidates.add(candidate)
    return candidate
  }

  private forgetCandidate(candidate: LumenPresentationCandidate): void {
    if (this.active.get(candidate.view) === candidate) {
      this.active.delete(candidate.view)
    }
    if (this.activeByArtifacts.get(candidate.artifacts) === candidate) {
      this.activeByArtifacts.delete(candidate.artifacts)
    }
    this.candidates.delete(candidate)
  }

  private candidateFor(
    context: PaginationLifecycleContext,
    supplied?: LumenPresentationCandidate,
  ): LumenPresentationCandidate | undefined {
    const candidate = supplied ?? this.activeByArtifacts.get(context.artifacts)
    if (
      !candidate ||
      !this.candidates.has(candidate) ||
      candidate.view !== context.view ||
      candidate.artifacts !== context.artifacts ||
      candidate.renderedDocument !== context.contents.document
    ) {
      return undefined
    }
    return candidate
  }

  private releaseRun(
    run: PresentationRun,
    coordinator: PresentationRunCoordinator,
  ): void {
    this.runs.delete(run)
    coordinator.release(run)
  }

  private armCandidateAbort(
    context: PaginationLifecycleContext,
    candidate: LumenPresentationCandidate,
  ): void {
    candidate.releaseAbort()
    const onAbort = (): void => {
      const awaitingAfterPagination = this.candidates.has(candidate)
      const geometryWasAdapted = Boolean(
        candidate.authorThemeLayer || candidate.geometryLayer,
      )
      candidate.geometryLayer?.restore()
      candidate.paletteLayer?.restore()
      candidate.listMarkerLayer?.restore()
      candidate.strokeLayer?.restore()
      candidate.explicitForegroundLayer?.restore()
      candidate.foregroundLayer?.restore()
      candidate.authorThemeLayer?.restore()
      this.forgetCandidate(candidate)
      this.runs.delete(candidate.run)
      candidate.coordinator.release(candidate.run)
      if (awaitingAfterPagination) {
        const budgetFailure =
          candidate.run.signal.reason instanceof PresentationRunBudgetError
        const publishedGeometryStable = this.repaginatePublishedAfterRestore(
          context,
          geometryWasAdapted,
        )
        if (!publishedGeometryStable) {
          candidate.run.record('published-repagination-failed')
        }
        this.report(
          context,
          budgetFailure ? 'published-fallback' : 'cancelled',
          candidate.run,
          budgetFailure
            ? {
                reason: 'presentation-timeout',
                legibility: this.legibility(context, candidate.policy),
              }
            : {},
          publishedGeometryStable,
        )
      }
    }
    candidate.run.signal.addEventListener('abort', onAbort, { once: true })
    candidate.releaseAbort = () =>
      candidate.run.signal.removeEventListener('abort', onAbort)
    if (candidate.run.signal.aborted) onAbort()
  }

  private report(
    context: PaginationLifecycleContext,
    status: LumenPresentationOutcome['status'],
    run?: PresentationRun,
    extra: Partial<LumenPresentationOutcome> = {},
    stablePublishedGeometry = false,
  ): void {
    const artifactSpineIndex = context.section.index
    if (
      Number.isInteger(artifactSpineIndex) &&
      artifactSpineIndex! >= 0 &&
      (status === 'adapted' ||
        status === 'published-disabled' ||
        status === 'published-readable' ||
        status === 'published-unproven' ||
        (status === 'cancelled' && stablePublishedGeometry) ||
        (status === 'published-fallback' && stablePublishedGeometry))
    ) {
      const acceptedPlan = extra.accepted?.plan
      recordPaginationGeometryArtifact(context.artifacts, {
        artifactsVersion: PAGINATION_ARTIFACTS_VERSION,
        producerId: LUMEN_PRESENTATION_GEOMETRY_PRODUCER_ID,
        producerVersion: LUMEN_PRESENTATION_GEOMETRY_PIPELINE_VERSION,
        spineIndex: artifactSpineIndex!,
        status: acceptedPlan ? 'accepted' : 'published',
        geometryPlanHash: acceptedPlan?.geometryPlanHash,
        geometryAffecting:
          acceptedPlan?.patches.some(
            (patch) => patch.effects.geometry !== 'none',
          ) ?? false,
      })
    }
    try {
      this.options.onOutcome?.({
        status,
        purpose: context.purpose,
        spineIndex: context.section.index ?? -1,
        elapsedMs: run?.elapsedMs,
        diagnostics: run ? diagnostics(run) : [],
        ...extra,
      })
    } catch {
      // Diagnostics are observational and must never block a safe reveal.
    }
  }

  /** Measure the concrete terminal DOM; never reuse Published evidence for an
   * Adapted result because paint layers may have changed every classification.
   */
  private legibility(
    context: PaginationLifecycleContext,
    policy: LumenPresentationPolicy,
  ): PresentationLegibilitySummary {
    try {
      return summarizePresentationLegibility({
        healthMap: createPresentationHealthMap({
          renderedDocument: context.contents.document,
          spineIndex: context.section.index ?? -1,
          canvasColor: policy.canvasColor,
          maxInspectedElements: MAX_PRESENTATION_HEALTH_ELEMENTS,
        }),
        minimumTextContrast: policy.minimumTextContrast,
      })
    } catch {
      return Object.freeze({
        modelVersion: PRESENTATION_LEGIBILITY_MODEL_VERSION,
        complete: false,
        truncated: true,
        visibleTextSamples: 0,
        visibleTextCodePoints: 0,
        nonVisibleTextSamples: 0,
        nonVisibleTextCodePoints: 0,
        provenReadableSamples: 0,
        provenReadableCodePoints: 0,
        knownLowContrastSamples: 0,
        knownLowContrastCodePoints: 0,
        unknownPaintSamples: 0,
        unknownPaintCodePoints: 0,
        visibleStrokeSides: 0,
        provenReadableStrokeSides: 0,
        knownLowContrastStrokeSides: 0,
        unknownStrokeSides: 0,
        unknownPaintByReason: Object.freeze({}),
        analysisFailure: 'health-map-unavailable',
      })
    }
  }

  private safeFallback(
    candidate: LumenPresentationCandidate,
    reason: string,
  ): void {
    candidate.releaseAbort()
    candidate.geometryLayer?.restore()
    candidate.paletteLayer?.restore()
    candidate.listMarkerLayer?.restore()
    candidate.strokeLayer?.restore()
    candidate.explicitForegroundLayer?.restore()
    candidate.foregroundLayer?.restore()
    candidate.authorThemeLayer?.restore()
    this.forgetCandidate(candidate)
    this.runs.delete(candidate.run)
    if (
      !candidate.run.signal.aborted &&
      candidate.coordinator.isCurrent(candidate.run)
    ) {
      candidate.run.record(reason)
      candidate.coordinator.finish(candidate.run, 'fallback')
    } else {
      candidate.coordinator.release(candidate.run)
    }
  }

  /**
   * An author-theme or containment candidate may already have been measured
   * into Layout/IframeView caches. Removing its CSS/DOM is not enough: rebuild
   * the published layout before the hidden iframe is revealed.
   */
  private repaginatePublishedAfterRestore(
    context: PaginationLifecycleContext,
    geometryWasAdapted: boolean,
  ): boolean {
    if (!geometryWasAdapted) return true
    try {
      context.layout.format(context.contents, context.section, context.axis)
      context.view.expand(true)
      return true
    } catch {
      return false
    }
  }

  private async beforePagination(
    context: PaginationLifecycleContext,
    signal?: AbortSignal,
  ): Promise<LumenPresentationCandidate | undefined> {
    const lifecycleEpoch = this.lifecycleEpoch
    const budget = {
      ...DEFAULT_PRESENTATION_RUN_BUDGET,
      ...this.options.budget,
    }
    const policyStartedAt = Date.now()
    restoreGeometryPresentationLayer(context.contents.document)
    restorePresentationLayer(context.contents.document)
    restoreListMarkerLayer(context.contents.document)
    restoreStrokeContrastLayer(context.contents.document)
    restoreExplicitForegroundLayer(context.contents.document)
    restoreInheritedForegroundLayer(context.contents.document)
    restoreAuthorThemeLayer(context.contents.document)
    const previous = this.active.get(context.view)
    if (previous) this.safeFallback(previous, 'superseded-before-pagination')
    this.active.delete(context.view)

    let policy: LumenPresentationPolicy
    try {
      policy = normalizePolicy(
        await withDeadline(
          this.options.resolvePolicy(context, signal),
          signal,
          budget.maxElapsedMs,
        ),
      )
      if (lifecycleEpoch !== this.lifecycleEpoch) return undefined
    } catch (error) {
      if (isAbort(error) || signal?.aborted) throw error
      this.report(context, 'published-fallback', undefined, {
        reason: isBudgetError(error)
          ? 'policy-resolution-timeout'
          : 'policy-resolution-failed',
      })
      return undefined
    }
    if (!policy.enabled || policy.mode !== 'adaptive') {
      this.report(context, 'published-disabled')
      return undefined
    }

    const coordinator = this.coordinator(context.view)
    let run: PresentationRun
    try {
      run = coordinator.start(
        {
          publicationRevision: policy.publicationRevision,
          spineIndex: context.section.index ?? -1,
          analysisFingerprint: `${policy.analysisFingerprint}|source:${SOURCE_TREE_MODEL_VERSION}.${SOURCE_SIGNATURE_VERSION}|health:${PRESENTATION_HEALTH_MODEL_VERSION}|author-theme:${AUTHOR_THEME_RESOLVER_VERSION}|foreground:${INHERITED_FOREGROUND_ANALYZER_VERSION}|explicit-foreground:${EXPLICIT_FOREGROUND_ANALYZER_VERSION}|list-marker:${LIST_MARKER_ANALYZER_VERSION}|stroke:${STROKE_CONTRAST_ANALYZER_VERSION}|palette:${OPAQUE_PALETTE_ANALYZER_VERSION}|wide-table:${WIDE_TABLE_ANALYZER_VERSION}`,
          renderingContextFingerprint: `${
            policy.renderingContextFingerprint
          }|${canonicalJson({
            canvas: policy.canvasColor,
            colorModel: PRESENTATION_COLOR_MODEL_VERSION,
            minimumTextContrast: policy.minimumTextContrast,
            mode: policy.mode,
          })}`,
        },
        {
          signal,
          budget: {
            ...budget,
            maxElapsedMs: Math.max(
              0,
              budget.maxElapsedMs - (Date.now() - policyStartedAt),
            ),
          },
        },
      )
      this.runs.add(run)
    } catch {
      this.report(context, 'published-fallback', undefined, {
        reason: 'invalid-run-context',
      })
      return undefined
    }

    try {
      run.transition('probing')
      const request =
        this.options.request ??
        ((path, type, credentials, headers, requestSignal) =>
          this.rendition.book.load(
            path,
            type,
            credentials,
            headers,
            requestSignal,
          ))
      const sourceDocument = await run.wait(
        context.section.loadSource(request, run.signal),
      )
      coordinator.assertCurrent(run)
      const authorThemeAnalysis = await run.wait(
        analyzeAuthorTheme({
          sourceDocument,
          renderedDocument: context.contents.document,
          spineIndex: run.identity.spineIndex,
          targetScheme: policy.colorScheme,
          canvasColor: policy.canvasColor,
          signal: run.signal,
          minimumTextContrast: policy.minimumTextContrast,
        }),
      )
      authorThemeAnalysis.diagnostics.forEach((code) =>
        run.record(`author-theme:${code}`),
      )
      let analysis: {
        findings: PresentationFinding[]
        patches: PresentationPatch[]
      } = authorThemeAnalysis
      let fallbackAnalysis:
        | { findings: PresentationFinding[]; patches: PresentationPatch[] }
        | undefined
      let foregroundRuntimeEvidence:
        | InheritedForegroundRuntimeEvidence
        | undefined
      const remainingAfterAuthorTheme = Math.max(
        0,
        run.budget.maxCandidates - authorThemeAnalysis.patches.length,
      )
      const healthMap = createPresentationHealthMap({
        renderedDocument: context.contents.document,
        spineIndex: run.identity.spineIndex,
        canvasColor: policy.canvasColor,
        signal: run.signal,
        maxInspectedElements: MAX_PRESENTATION_HEALTH_ELEMENTS,
      })
      const listMarkerAnalysis = await run.wait(
        analyzeListMarkerContrast({
          sourceDocument,
          renderedDocument: context.contents.document,
          spineIndex: run.identity.spineIndex,
          canvasColor: policy.canvasColor,
          signal: run.signal,
          minimumTextContrast: policy.minimumTextContrast,
          maxCandidates: Math.min(4, remainingAfterAuthorTheme),
          healthMap,
        }),
      )
      for (const diagnostic of listMarkerAnalysis.diagnostics) {
        run.record(`list-marker:${diagnostic}`)
      }
      const remainingAfterListMarkers = Math.max(
        0,
        remainingAfterAuthorTheme - listMarkerAnalysis.patches.length,
      )
      const strokeAnalysis = await run.wait(
        analyzeStrokeContrast({
          sourceDocument,
          renderedDocument: context.contents.document,
          spineIndex: run.identity.spineIndex,
          canvasColor: policy.canvasColor,
          signal: run.signal,
          maxCandidates: Math.min(4, remainingAfterListMarkers),
          healthMap,
        }),
      )
      for (const diagnostic of strokeAnalysis.diagnostics) {
        run.record(`stroke:${diagnostic}`)
      }
      const remainingAfterStrokes = Math.max(
        0,
        remainingAfterListMarkers - strokeAnalysis.patches.length,
      )
      const explicitForegroundAnalysis = await run.wait(
        analyzeExplicitForegroundContrast({
          sourceDocument,
          renderedDocument: context.contents.document,
          spineIndex: run.identity.spineIndex,
          canvasColor: policy.canvasColor,
          signal: run.signal,
          minimumTextContrast: policy.minimumTextContrast,
          maxCandidates: remainingAfterStrokes,
          healthMap,
        }),
      )
      for (const diagnostic of explicitForegroundAnalysis.diagnostics) {
        run.record(diagnostic)
      }
      let contrastRepairAnalysis: {
        findings: PresentationFinding[]
        patches: PresentationPatch[]
      } = {
        findings: [
          ...explicitForegroundAnalysis.findings,
          ...listMarkerAnalysis.findings,
          ...strokeAnalysis.findings,
        ],
        patches: [
          ...explicitForegroundAnalysis.patches,
          ...listMarkerAnalysis.patches,
          ...strokeAnalysis.patches,
        ],
      }
      if (policy.colorScheme === 'dark') {
        const foregroundAnalysis = await run.wait(
          analyzeInheritedForegroundForDarkTheme({
            sourceDocument,
            renderedDocument: context.contents.document,
            spineIndex: run.identity.spineIndex,
            canvasColor: policy.canvasColor,
            signal: run.signal,
            minimumTextContrast: policy.minimumTextContrast,
            maxInspectedElements: MAX_PRESENTATION_HEALTH_ELEMENTS - 1,
            maxCandidates: remainingAfterStrokes,
            healthMap,
          }),
        )
        foregroundRuntimeEvidence = foregroundAnalysis.runtimeEvidence
        // The explicit operation marks only the proven low-contrast glyph
        // owners. When it can provide a complete local plan, prefer it over a
        // body-wide inherited override so authored descendants with the same
        // computed color cannot escape through CSS inheritance provenance.
        const selectedForegroundAnalysis =
          explicitForegroundAnalysis.patches.length > 0
            ? explicitForegroundAnalysis
            : foregroundAnalysis
        if (selectedForegroundAnalysis !== foregroundAnalysis) {
          foregroundRuntimeEvidence = undefined
        }
        const paletteAnalysis = await run.wait(
          analyzeOpaquePaletteForDarkTheme({
            sourceDocument,
            renderedDocument: context.contents.document,
            spineIndex: run.identity.spineIndex,
            canvasColor: policy.canvasColor,
            signal: run.signal,
            maxInspectedElements: 512,
            maxCandidates: Math.max(
              0,
              remainingAfterStrokes - selectedForegroundAnalysis.patches.length,
            ),
            minimumTextContrast: policy.minimumTextContrast,
            healthMap,
          }),
        )
        contrastRepairAnalysis = {
          findings: [
            ...selectedForegroundAnalysis.findings,
            ...listMarkerAnalysis.findings,
            ...strokeAnalysis.findings,
            ...paletteAnalysis.findings,
          ],
          patches: [
            ...selectedForegroundAnalysis.patches,
            ...listMarkerAnalysis.patches,
            ...strokeAnalysis.patches,
            ...paletteAnalysis.patches,
          ],
        }
      }
      if (authorThemeAnalysis.patches.length === 0) {
        analysis = contrastRepairAnalysis
      } else if (contrastRepairAnalysis.patches.length > 0) {
        fallbackAnalysis = contrastRepairAnalysis
      }
      coordinator.assertCurrent(run)
      analysis.patches.forEach(() => run.consumeCandidate())
      if (analysis.patches.length === 0) {
        // Wide-table evidence is only trustworthy after the real pagination.
        // Keep the iframe hidden and carry the same run into afterPagination.
        const candidate: LumenPresentationCandidate = {
          run,
          coordinator,
          policy,
          sourceDocument,
          view: context.view,
          artifacts: context.artifacts,
          renderedDocument: context.contents.document,
          fallbackAnalysis,
          foregroundRuntimeEvidence,
          releaseAbort: () => undefined,
        }
        this.rememberCandidate(context, candidate)
        this.armCandidateAbort(context, candidate)
        return candidate
      }

      run.transition('planning')
      run.beginIteration()
      const plan = await run.wait(
        createPresentationPlan(
          {
            schemaVersion: PRESENTATION_PLAN_SCHEMA_VERSION,
            engineVersion: LUMEN_PRESENTATION_ENGINE_VERSION,
            mode: 'adaptive',
            publicationRevision: run.identity.publicationRevision,
            analysisFingerprint: run.identity.analysisFingerprint,
            renderingContextFingerprint:
              run.identity.renderingContextFingerprint,
            findings: analysis.findings,
            patches: analysis.patches,
          },
          PRESENTATION_OPERATION_VALIDATORS,
        ),
      )
      coordinator.assertCurrent(run)
      if (!plan) {
        run.record('strong-hash-unavailable')
        coordinator.finish(run, 'fallback')
        this.runs.delete(run)
        this.report(
          context,
          'published-fallback',
          run,
          {
            reason: 'strong-hash-unavailable',
            legibility: this.legibility(context, policy),
          },
          true,
        )
        return undefined
      }

      run.transition('paginating')
      const authorThemeLayer = await run.wait(
        applyAuthorThemePlan(
          plan,
          sourceDocument,
          context.contents.document,
          run.identity.spineIndex,
          run.signal,
        ),
      )
      coordinator.assertCurrent(run)
      const strokeLayer = plan.patches.some(
        (patch) => patch.operation === 'restore-visible-stroke',
      )
        ? await run.wait(
            applyRestoreVisibleStrokePlan(
              plan,
              sourceDocument,
              context.contents.document,
              run.identity.spineIndex,
              run.signal,
            ),
          )
        : undefined
      coordinator.assertCurrent(run)
      // Marker evidence is captured from Published paint. Apply its dedicated
      // pseudo layer before foreground repairs: changing an LI's currentColor
      // can incidentally make ::marker readable and must not invalidate the
      // independently planned marker operation.
      const listMarkerLayer = plan.patches.some(
        (patch) => patch.operation === 'restore-list-marker',
      )
        ? await run.wait(
            applyRestoreListMarkerPlan(
              plan,
              sourceDocument,
              context.contents.document,
              run.identity.spineIndex,
              run.signal,
            ),
          )
        : undefined
      coordinator.assertCurrent(run)
      const foregroundLayer = plan.patches.some(
        (patch) => patch.operation === 'restore-visible-text',
      )
        ? await run.wait(
            applyRestoreVisibleTextPlan(
              plan,
              sourceDocument,
              context.contents.document,
              run.identity.spineIndex,
              run.signal,
              foregroundRuntimeEvidence,
            ),
          )
        : undefined
      coordinator.assertCurrent(run)
      const explicitForegroundLayer = plan.patches.some(
        (patch) => patch.operation === 'restore-explicit-text',
      )
        ? await run.wait(
            applyRestoreExplicitTextPlan(
              plan,
              sourceDocument,
              context.contents.document,
              run.identity.spineIndex,
              run.signal,
            ),
          )
        : undefined
      coordinator.assertCurrent(run)
      const paletteLayer = plan.patches.some(
        (patch) => patch.operation === 'remap-palette',
      )
        ? await run.wait(
            applyRemapPalettePlan(
              plan,
              sourceDocument,
              context.contents.document,
              run.identity.spineIndex,
              run.signal,
            ),
          )
        : undefined
      coordinator.assertCurrent(run)
      const candidate: LumenPresentationCandidate = {
        run,
        coordinator,
        policy,
        sourceDocument,
        view: context.view,
        artifacts: context.artifacts,
        renderedDocument: context.contents.document,
        fallbackAnalysis,
        foregroundRuntimeEvidence,
        plan,
        authorThemeLayer,
        foregroundLayer,
        explicitForegroundLayer,
        listMarkerLayer,
        strokeLayer,
        paletteLayer,
        releaseAbort: () => undefined,
      }
      this.rememberCandidate(context, candidate)
      this.armCandidateAbort(context, candidate)
      return candidate
    } catch (error) {
      const restoredOverflowGeometry = restoreGeometryPresentationLayer(
        context.contents.document,
      )
      restorePresentationLayer(context.contents.document)
      restoreListMarkerLayer(context.contents.document)
      restoreStrokeContrastLayer(context.contents.document)
      restoreExplicitForegroundLayer(context.contents.document)
      restoreInheritedForegroundLayer(context.contents.document)
      const restoredAuthorGeometry = restoreAuthorThemeLayer(
        context.contents.document,
      )
      const publishedGeometryStable = this.repaginatePublishedAfterRestore(
        context,
        restoredAuthorGeometry || restoredOverflowGeometry,
      )
      if (!publishedGeometryStable) {
        run.record('published-repagination-failed')
      }
      const budgetFailure =
        isBudgetError(error) ||
        run.signal.reason instanceof PresentationRunBudgetError
      if (
        !budgetFailure &&
        (isAbort(error) || signal?.aborted || run.signal.aborted)
      ) {
        this.releaseRun(run, coordinator)
        this.report(context, 'cancelled', run, {}, publishedGeometryStable)
        throw new PresentationRunCancelledError()
      }
      if (coordinator.owns(run)) {
        const errorName =
          error instanceof Error && error.name ? error.name : 'UnknownError'
        const errorMessage =
          error instanceof Error && error.message
            ? error.message.replace(/\s+/gu, ' ').slice(0, 240)
            : 'no-message'
        run.record(`before-pagination-error:${errorName}:${errorMessage}`)
        run.record(
          budgetFailure
            ? 'before-pagination-timeout'
            : 'before-pagination-failed',
        )
        coordinator.finish(run, 'fallback')
      }
      this.runs.delete(run)
      this.report(
        context,
        'published-fallback',
        run,
        {
          reason: budgetFailure
            ? 'before-pagination-timeout'
            : 'before-pagination-failed',
          legibility: this.legibility(context, policy),
        },
        publishedGeometryStable,
      )
      return undefined
    }
  }

  private async afterPagination(
    context: PaginationLifecycleContext,
    signal?: AbortSignal,
    lifecycleCandidate?: LumenPresentationCandidate,
  ): Promise<ValidationRecord | undefined> {
    if (signal?.aborted) throw new PresentationRunCancelledError()
    const candidate = this.candidateFor(context, lifecycleCandidate)
    if (!candidate) return undefined
    this.forgetCandidate(candidate)

    try {
      candidate.coordinator.assertCurrent(candidate.run)
      const effectiveLayout = sectionLayoutName(
        context.section,
        context.layout.name,
      )
      // If an authored branch fails validation, its independent paint repair
      // is still entitled to the candidates left after that primary branch.
      // Reserve them before probing geometry so the fallback can never exceed
      // the same global run budget when it is combined with overflow repairs.
      const reservedFallbackCandidates =
        candidate.authorThemeLayer && candidate.fallbackAnalysis
          ? candidate.fallbackAnalysis.patches.length
          : 0
      const postPaginationStrokeAnalysis = await candidate.run.wait(
        analyzeStrokeContrast({
          sourceDocument: candidate.sourceDocument,
          renderedDocument: context.contents.document,
          spineIndex: candidate.run.identity.spineIndex,
          canvasColor: candidate.policy.canvasColor,
          signal: candidate.run.signal,
          maxCandidates: Math.max(
            0,
            candidate.run.budget.maxCandidates -
              candidate.run.candidateCount -
              reservedFallbackCandidates,
          ),
        }),
      )
      postPaginationStrokeAnalysis.diagnostics.forEach((code) =>
        candidate.run.record(`post-pagination-stroke:${code}`),
      )
      const geometryAnalysis = await candidate.run.wait(
        analyzeWideTableOverflow({
          sourceDocument: candidate.sourceDocument,
          renderedDocument: context.contents.document,
          spineIndex: candidate.run.identity.spineIndex,
          pageInlineSize: context.layout.columnWidth,
          pageBlockSize: context.layout.height,
          layout:
            effectiveLayout === 'pre-paginated'
              ? 'pre-paginated'
              : 'reflowable',
          flow: context.layout._flow === 'paginated' ? 'paginated' : 'scrolled',
          axis: context.axis,
          writingMode: context.writingMode,
          signal: candidate.run.signal,
          maxCandidates: Math.max(
            0,
            candidate.run.budget.maxCandidates -
              candidate.run.candidateCount -
              postPaginationStrokeAnalysis.patches.length -
              reservedFallbackCandidates,
          ),
        }),
      )
      geometryAnalysis.diagnostics.forEach((code) =>
        candidate.run.record(`wide-table:${code}`),
      )
      candidate.coordinator.assertCurrent(candidate.run)

      let overflowGeometryStable = true
      if (
        postPaginationStrokeAnalysis.patches.length > 0 ||
        geometryAnalysis.patches.length > 0
      ) {
        postPaginationStrokeAnalysis.patches.forEach(() =>
          candidate.run.consumeCandidate(),
        )
        geometryAnalysis.patches.forEach(() => candidate.run.consumeCandidate())
        candidate.run.transition('planning', 'post-pagination-plan')
        candidate.run.beginIteration()
        const plan = await candidate.run.wait(
          createPresentationPlan(
            {
              schemaVersion: PRESENTATION_PLAN_SCHEMA_VERSION,
              engineVersion: LUMEN_PRESENTATION_ENGINE_VERSION,
              mode: 'adaptive',
              publicationRevision: candidate.run.identity.publicationRevision,
              analysisFingerprint: candidate.run.identity.analysisFingerprint,
              renderingContextFingerprint:
                candidate.run.identity.renderingContextFingerprint,
              findings: [
                ...(candidate.plan?.findings ?? []),
                ...postPaginationStrokeAnalysis.findings,
                ...geometryAnalysis.findings,
              ],
              patches: [
                ...(candidate.plan?.patches ?? []),
                ...postPaginationStrokeAnalysis.patches,
                ...geometryAnalysis.patches,
              ],
            },
            PRESENTATION_OPERATION_VALIDATORS,
          ),
        )
        candidate.coordinator.assertCurrent(candidate.run)
        if (!plan) {
          const geometryWasAdapted = Boolean(
            candidate.authorThemeLayer || candidate.geometryLayer,
          )
          this.safeFallback(candidate, 'strong-hash-unavailable')
          const publishedGeometryStable = this.repaginatePublishedAfterRestore(
            context,
            geometryWasAdapted,
          )
          if (!publishedGeometryStable) {
            candidate.run.record('published-repagination-failed')
          }
          this.report(
            context,
            'published-fallback',
            candidate.run,
            {
              reason: 'strong-hash-unavailable',
              legibility: this.legibility(context, candidate.policy),
            },
            publishedGeometryStable,
          )
          return undefined
        }

        candidate.releaseAbort()
        candidate.geometryLayer?.restore()
        candidate.paletteLayer?.restore()
        candidate.listMarkerLayer?.restore()
        candidate.strokeLayer?.restore()
        candidate.explicitForegroundLayer?.restore()
        candidate.foregroundLayer?.restore()
        candidate.authorThemeLayer?.restore()
        candidate.plan = plan
        candidate.authorThemeLayer = plan.patches.some(
          (patch) => patch.operation === 'activate-author-theme',
        )
          ? await candidate.run.wait(
              applyAuthorThemePlan(
                plan,
                candidate.sourceDocument,
                context.contents.document,
                candidate.run.identity.spineIndex,
                candidate.run.signal,
              ),
            )
          : undefined
        candidate.strokeLayer = plan.patches.some(
          (patch) => patch.operation === 'restore-visible-stroke',
        )
          ? await candidate.run.wait(
              applyRestoreVisibleStrokePlan(
                plan,
                candidate.sourceDocument,
                context.contents.document,
                candidate.run.identity.spineIndex,
                candidate.run.signal,
              ),
            )
          : undefined
        candidate.listMarkerLayer = plan.patches.some(
          (patch) => patch.operation === 'restore-list-marker',
        )
          ? await candidate.run.wait(
              applyRestoreListMarkerPlan(
                plan,
                candidate.sourceDocument,
                context.contents.document,
                candidate.run.identity.spineIndex,
                candidate.run.signal,
              ),
            )
          : undefined
        candidate.foregroundLayer = plan.patches.some(
          (patch) => patch.operation === 'restore-visible-text',
        )
          ? await candidate.run.wait(
              applyRestoreVisibleTextPlan(
                plan,
                candidate.sourceDocument,
                context.contents.document,
                candidate.run.identity.spineIndex,
                candidate.run.signal,
                candidate.foregroundRuntimeEvidence,
              ),
            )
          : undefined
        candidate.explicitForegroundLayer = plan.patches.some(
          (patch) => patch.operation === 'restore-explicit-text',
        )
          ? await candidate.run.wait(
              applyRestoreExplicitTextPlan(
                plan,
                candidate.sourceDocument,
                context.contents.document,
                candidate.run.identity.spineIndex,
                candidate.run.signal,
              ),
            )
          : undefined
        candidate.paletteLayer = plan.patches.some(
          (patch) => patch.operation === 'remap-palette',
        )
          ? await candidate.run.wait(
              applyRemapPalettePlan(
                plan,
                candidate.sourceDocument,
                context.contents.document,
                candidate.run.identity.spineIndex,
                candidate.run.signal,
              ),
            )
          : undefined
        candidate.geometryLayer = plan.patches.some(
          (patch) => patch.operation === 'contain-overflow',
        )
          ? await candidate.run.wait(
              applyContainOverflowPlan(
                plan,
                candidate.sourceDocument,
                context.contents.document,
                candidate.run.identity.spineIndex,
                candidate.run.signal,
              ),
            )
          : undefined
        this.armCandidateAbort(context, candidate)
        candidate.coordinator.assertCurrent(candidate.run)
        candidate.run.transition(
          'paginating',
          candidate.geometryLayer
            ? 'geometry-repagination'
            : 'post-pagination-paint',
        )

        if (candidate.geometryLayer) {
          // Repaginate the same hidden final iframe. expand(true) invalidates
          // its cached text extent so geometry changes are observable.
          context.layout.format(context.contents, context.section, context.axis)
          context.view.expand(true)
          overflowGeometryStable = await candidate.run.wait(
            waitForOverflowGeometryStability(
              candidate.geometryLayer,
              candidate.run.signal,
            ),
          )
          candidate.coordinator.assertCurrent(candidate.run)
        }
      }

      if (!candidate.plan) {
        candidate.run.record('no-high-confidence-finding')
        candidate.releaseAbort()
        candidate.coordinator.finish(candidate.run, 'fallback')
        this.runs.delete(candidate.run)
        this.candidates.delete(candidate)
        const legibility = this.legibility(context, candidate.policy)
        this.report(
          context,
          legibility.complete ? 'published-readable' : 'published-unproven',
          candidate.run,
          { legibility },
        )
        return undefined
      }

      candidate.run.transition('validating')
      const validationInputs: ValidationRecordInput[] = []
      if (candidate.authorThemeLayer) {
        const authorThemeGeometryStable = await candidate.run.wait(
          waitForAuthorThemeGeometryStability(
            candidate.authorThemeLayer,
            candidate.run.signal,
          ),
        )
        candidate.coordinator.assertCurrent(candidate.run)
        validationInputs.push(
          validateAppliedAuthorTheme(
            candidate.authorThemeLayer,
            authorThemeGeometryStable,
          ).input,
        )
      }
      if (candidate.paletteLayer) {
        validationInputs.push(
          validateAppliedPalettePlan(candidate.paletteLayer).input,
        )
      }
      if (candidate.foregroundLayer) {
        validationInputs.push(
          validateRestoredVisibleText(candidate.foregroundLayer).input,
        )
      }
      if (candidate.explicitForegroundLayer) {
        validationInputs.push(
          validateRestoredExplicitText(candidate.explicitForegroundLayer).input,
        )
      }
      if (candidate.listMarkerLayer) {
        validationInputs.push(
          validateRestoredListMarkers(candidate.listMarkerLayer).input,
        )
      }
      if (candidate.strokeLayer) {
        validationInputs.push(
          validateRestoredVisibleStrokes(candidate.strokeLayer).input,
        )
      }
      if (candidate.geometryLayer) {
        validationInputs.push(
          validateContainedOverflowPlan(
            candidate.geometryLayer,
            overflowGeometryStable,
          ).input,
        )
      }
      const validation = createValidationRecord(
        candidate.plan,
        combineValidationInputs(validationInputs),
      )
      const admission = await candidate.run.wait(
        admitPresentationPlan(candidate.plan, validation, {
          engineVersion: LUMEN_PRESENTATION_ENGINE_VERSION,
          publicationRevision: candidate.run.identity.publicationRevision,
          analysisFingerprint: candidate.run.identity.analysisFingerprint,
          renderingContextFingerprint:
            candidate.run.identity.renderingContextFingerprint,
          validators: PRESENTATION_OPERATION_VALIDATORS,
        }),
      )
      candidate.coordinator.assertCurrent(candidate.run)
      if (!admission.accepted) {
        if (
          candidate.authorThemeLayer &&
          candidate.fallbackAnalysis &&
          (candidate.fallbackAnalysis.patches.length > 0 ||
            geometryAnalysis.patches.length > 0)
        ) {
          return this.tryFallbackCandidate(
            context,
            candidate,
            candidate.fallbackAnalysis,
            geometryAnalysis.patches.length,
          )
        }
        const geometryWasAdapted = Boolean(
          candidate.authorThemeLayer || candidate.geometryLayer,
        )
        this.safeFallback(candidate, 'validation-rejected')
        const publishedGeometryStable = this.repaginatePublishedAfterRestore(
          context,
          geometryWasAdapted,
        )
        if (!publishedGeometryStable) {
          candidate.run.record('published-repagination-failed')
        }
        this.report(
          context,
          'published-fallback',
          candidate.run,
          {
            plan: candidate.plan,
            validation,
            reason:
              'reasons' in admission
                ? admission.reasons.join(',')
                : 'validation-rejected',
            legibility: this.legibility(context, candidate.policy),
          },
          publishedGeometryStable,
        )
        return validation
      }

      candidate.coordinator.publish(candidate.run, () => admission.value)
      candidate.releaseAbort()
      candidate.coordinator.finish(candidate.run, 'ready')
      this.runs.delete(candidate.run)
      this.candidates.delete(candidate)
      this.report(context, 'adapted', candidate.run, {
        plan: candidate.plan,
        validation,
        accepted: admission.value,
        legibility: this.legibility(context, candidate.policy),
      })
      return validation
    } catch (error) {
      candidate.geometryLayer?.restore()
      candidate.paletteLayer?.restore()
      candidate.listMarkerLayer?.restore()
      candidate.strokeLayer?.restore()
      candidate.explicitForegroundLayer?.restore()
      candidate.foregroundLayer?.restore()
      candidate.authorThemeLayer?.restore()
      candidate.releaseAbort()
      const geometryWasAdapted = Boolean(
        candidate.authorThemeLayer || candidate.geometryLayer,
      )
      const publishedGeometryStable = this.repaginatePublishedAfterRestore(
        context,
        geometryWasAdapted,
      )
      if (!publishedGeometryStable) {
        candidate.run.record('published-repagination-failed')
      }
      const budgetFailure =
        isBudgetError(error) ||
        candidate.run.signal.reason instanceof PresentationRunBudgetError
      if (
        !budgetFailure &&
        (isAbort(error) || signal?.aborted || candidate.run.signal.aborted)
      ) {
        this.releaseRun(candidate.run, candidate.coordinator)
        this.report(
          context,
          'cancelled',
          candidate.run,
          {},
          publishedGeometryStable,
        )
        throw new PresentationRunCancelledError()
      }
      if (candidate.coordinator.owns(candidate.run)) {
        const errorName =
          error instanceof Error && error.name ? error.name : 'UnknownError'
        const errorMessage =
          error instanceof Error && error.message
            ? error.message.replace(/\s+/gu, ' ').slice(0, 240)
            : 'no-message'
        candidate.run.record(
          `after-pagination-error:${errorName}:${errorMessage}`,
        )
        candidate.run.record(
          budgetFailure
            ? 'after-pagination-timeout'
            : 'after-pagination-failed',
        )
        candidate.coordinator.finish(candidate.run, 'fallback')
      }
      this.runs.delete(candidate.run)
      this.candidates.delete(candidate)
      this.report(
        context,
        'published-fallback',
        candidate.run,
        {
          plan: candidate.plan,
          reason: budgetFailure
            ? 'after-pagination-timeout'
            : 'after-pagination-failed',
          legibility: this.legibility(context, candidate.policy),
        },
        publishedGeometryStable,
      )
      return undefined
    }
  }

  /** Try the next independent, bounded candidate after an author theme fails. */
  private async tryFallbackCandidate(
    context: PaginationLifecycleContext,
    candidate: LumenPresentationCandidate,
    analysis: { findings: PresentationFinding[]; patches: PresentationPatch[] },
    prepaidGeometryCandidates: number,
  ): Promise<ValidationRecord | undefined> {
    const { run, coordinator } = candidate
    try {
      run.transition('rejected', 'candidate-validation-rejected')
      candidate.releaseAbort()
      candidate.geometryLayer?.restore()
      candidate.paletteLayer?.restore()
      candidate.listMarkerLayer?.restore()
      candidate.strokeLayer?.restore()
      candidate.explicitForegroundLayer?.restore()
      candidate.foregroundLayer?.restore()
      candidate.authorThemeLayer?.restore()
      candidate.authorThemeLayer = undefined
      candidate.foregroundLayer = undefined
      candidate.explicitForegroundLayer = undefined
      candidate.listMarkerLayer = undefined
      candidate.strokeLayer = undefined
      candidate.paletteLayer = undefined
      candidate.geometryLayer = undefined

      // Restore Published geometry before capturing the paint-only fallback's
      // validation baseline. The failed authored branch may have reflowed it.
      context.layout.format(context.contents, context.section, context.axis)
      context.view.expand(true)

      analysis.patches.forEach(() => run.consumeCandidate())
      // Geometry evidence captured under the rejected author theme is stale:
      // that branch may have changed table fonts, widths, or even visibility.
      // Re-probe Published after restoring and repaginating it. Previously
      // consumed geometry slots remain prepaid; only additional candidates
      // consume the remaining global budget.
      const remainingCandidates = Math.max(
        0,
        run.budget.maxCandidates - run.candidateCount,
      )
      const effectiveLayout = sectionLayoutName(
        context.section,
        context.layout.name,
      )
      const geometryAnalysis = await run.wait(
        analyzeWideTableOverflow({
          sourceDocument: candidate.sourceDocument,
          renderedDocument: context.contents.document,
          spineIndex: run.identity.spineIndex,
          pageInlineSize: context.layout.columnWidth,
          pageBlockSize: context.layout.height,
          layout:
            effectiveLayout === 'pre-paginated'
              ? 'pre-paginated'
              : 'reflowable',
          flow: context.layout._flow === 'paginated' ? 'paginated' : 'scrolled',
          axis: context.axis,
          writingMode: context.writingMode,
          signal: run.signal,
          maxCandidates: Math.min(
            16,
            prepaidGeometryCandidates + remainingCandidates,
          ),
        }),
      )
      geometryAnalysis.diagnostics.forEach((code) =>
        run.record(`fallback-wide-table:${code}`),
      )
      const additionalGeometryCandidates = Math.max(
        0,
        geometryAnalysis.patches.length - prepaidGeometryCandidates,
      )
      for (let index = 0; index < additionalGeometryCandidates; index += 1) {
        run.consumeCandidate()
      }
      if (
        analysis.patches.length === 0 &&
        geometryAnalysis.patches.length === 0
      ) {
        this.safeFallback(candidate, 'fallback-no-current-finding')
        this.report(
          context,
          'published-fallback',
          run,
          {
            reason: 'fallback-no-current-finding',
            legibility: this.legibility(context, candidate.policy),
          },
          true,
        )
        return undefined
      }
      run.transition('planning', 'fallback-candidate-plan')
      run.beginIteration()
      const plan = await run.wait(
        createPresentationPlan(
          {
            schemaVersion: PRESENTATION_PLAN_SCHEMA_VERSION,
            engineVersion: LUMEN_PRESENTATION_ENGINE_VERSION,
            mode: 'adaptive',
            publicationRevision: run.identity.publicationRevision,
            analysisFingerprint: run.identity.analysisFingerprint,
            renderingContextFingerprint:
              run.identity.renderingContextFingerprint,
            findings: [...analysis.findings, ...geometryAnalysis.findings],
            patches: [...analysis.patches, ...geometryAnalysis.patches],
          },
          PRESENTATION_OPERATION_VALIDATORS,
        ),
      )
      coordinator.assertCurrent(run)
      if (!plan) {
        this.safeFallback(candidate, 'fallback-strong-hash-unavailable')
        this.report(
          context,
          'published-fallback',
          run,
          {
            reason: 'fallback-strong-hash-unavailable',
            legibility: this.legibility(context, candidate.policy),
          },
          true,
        )
        return undefined
      }
      candidate.plan = plan
      candidate.strokeLayer = plan.patches.some(
        (patch) => patch.operation === 'restore-visible-stroke',
      )
        ? await run.wait(
            applyRestoreVisibleStrokePlan(
              plan,
              candidate.sourceDocument,
              context.contents.document,
              run.identity.spineIndex,
              run.signal,
            ),
          )
        : undefined
      candidate.listMarkerLayer = plan.patches.some(
        (patch) => patch.operation === 'restore-list-marker',
      )
        ? await run.wait(
            applyRestoreListMarkerPlan(
              plan,
              candidate.sourceDocument,
              context.contents.document,
              run.identity.spineIndex,
              run.signal,
            ),
          )
        : undefined
      candidate.foregroundLayer = plan.patches.some(
        (patch) => patch.operation === 'restore-visible-text',
      )
        ? await run.wait(
            applyRestoreVisibleTextPlan(
              plan,
              candidate.sourceDocument,
              context.contents.document,
              run.identity.spineIndex,
              run.signal,
              candidate.foregroundRuntimeEvidence,
            ),
          )
        : undefined
      candidate.explicitForegroundLayer = plan.patches.some(
        (patch) => patch.operation === 'restore-explicit-text',
      )
        ? await run.wait(
            applyRestoreExplicitTextPlan(
              plan,
              candidate.sourceDocument,
              context.contents.document,
              run.identity.spineIndex,
              run.signal,
            ),
          )
        : undefined
      candidate.paletteLayer = plan.patches.some(
        (patch) => patch.operation === 'remap-palette',
      )
        ? await run.wait(
            applyRemapPalettePlan(
              plan,
              candidate.sourceDocument,
              context.contents.document,
              run.identity.spineIndex,
              run.signal,
            ),
          )
        : undefined
      candidate.geometryLayer = geometryAnalysis.patches.length
        ? await run.wait(
            applyContainOverflowPlan(
              plan,
              candidate.sourceDocument,
              context.contents.document,
              run.identity.spineIndex,
              run.signal,
            ),
          )
        : undefined
      this.armCandidateAbort(context, candidate)
      coordinator.assertCurrent(run)
      run.transition('paginating', 'fallback-candidate-pagination')
      let geometryStable = true
      if (candidate.geometryLayer) {
        context.layout.format(context.contents, context.section, context.axis)
        context.view.expand(true)
        geometryStable = await run.wait(
          waitForOverflowGeometryStability(candidate.geometryLayer, run.signal),
        )
      }
      coordinator.assertCurrent(run)
      run.transition('validating', 'fallback-candidate-validation')
      const inputs: ValidationRecordInput[] = []
      if (candidate.foregroundLayer) {
        inputs.push(
          validateRestoredVisibleText(candidate.foregroundLayer).input,
        )
      }
      if (candidate.explicitForegroundLayer) {
        inputs.push(
          validateRestoredExplicitText(candidate.explicitForegroundLayer).input,
        )
      }
      if (candidate.paletteLayer) {
        inputs.push(validateAppliedPalettePlan(candidate.paletteLayer).input)
      }
      if (candidate.listMarkerLayer) {
        inputs.push(
          validateRestoredListMarkers(candidate.listMarkerLayer).input,
        )
      }
      if (candidate.strokeLayer) {
        inputs.push(validateRestoredVisibleStrokes(candidate.strokeLayer).input)
      }
      if (candidate.geometryLayer) {
        inputs.push(
          validateContainedOverflowPlan(candidate.geometryLayer, geometryStable)
            .input,
        )
      }
      const validation = createValidationRecord(
        plan,
        combineValidationInputs(inputs),
      )
      const admission = await run.wait(
        admitPresentationPlan(plan, validation, {
          engineVersion: LUMEN_PRESENTATION_ENGINE_VERSION,
          publicationRevision: run.identity.publicationRevision,
          analysisFingerprint: run.identity.analysisFingerprint,
          renderingContextFingerprint: run.identity.renderingContextFingerprint,
          validators: PRESENTATION_OPERATION_VALIDATORS,
        }),
      )
      coordinator.assertCurrent(run)
      if (!admission.accepted) {
        const geometryWasAdapted = Boolean(candidate.geometryLayer)
        this.safeFallback(candidate, 'fallback-validation-rejected')
        const publishedGeometryStable = this.repaginatePublishedAfterRestore(
          context,
          geometryWasAdapted,
        )
        if (!publishedGeometryStable) {
          run.record('published-repagination-failed')
        }
        this.report(
          context,
          'published-fallback',
          run,
          {
            plan,
            validation,
            reason: 'fallback-validation-rejected',
            legibility: this.legibility(context, candidate.policy),
          },
          publishedGeometryStable,
        )
        return validation
      }
      coordinator.publish(run, () => admission.value)
      candidate.releaseAbort()
      coordinator.finish(run, 'ready')
      this.runs.delete(run)
      this.forgetCandidate(candidate)
      this.report(context, 'adapted', run, {
        plan,
        validation,
        accepted: admission.value,
        reason: 'fallback-candidate-accepted',
        legibility: this.legibility(context, candidate.policy),
      })
      return validation
    } catch (error) {
      candidate.geometryLayer?.restore()
      candidate.paletteLayer?.restore()
      candidate.listMarkerLayer?.restore()
      candidate.strokeLayer?.restore()
      candidate.explicitForegroundLayer?.restore()
      candidate.foregroundLayer?.restore()
      candidate.releaseAbort()
      const geometryWasAdapted = Boolean(candidate.geometryLayer)
      const publishedGeometryStable = this.repaginatePublishedAfterRestore(
        context,
        geometryWasAdapted,
      )
      if (!publishedGeometryStable) {
        run.record('published-repagination-failed')
      }
      const budgetFailure =
        isBudgetError(error) ||
        run.signal.reason instanceof PresentationRunBudgetError
      if (!budgetFailure && (isAbort(error) || run.signal.aborted)) {
        this.releaseRun(run, coordinator)
        this.report(context, 'cancelled', run, {}, publishedGeometryStable)
        throw new PresentationRunCancelledError()
      }
      if (coordinator.owns(run)) coordinator.finish(run, 'fallback')
      this.runs.delete(run)
      this.forgetCandidate(candidate)
      this.report(
        context,
        'published-fallback',
        run,
        {
          reason: budgetFailure
            ? 'fallback-candidate-timeout'
            : 'fallback-candidate-failed',
          legibility: this.legibility(context, candidate.policy),
        },
        publishedGeometryStable,
      )
      return undefined
    }
  }
}

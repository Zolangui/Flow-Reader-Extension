import {
  canonicalJson,
  hashCanonicalJson,
  type CanonicalJsonValue,
} from './canonical-json'
import {
  SOURCE_TREE_MODEL_VERSION,
  type SourceTreeAddress,
} from './source-tree'

export const PRESENTATION_PLAN_SCHEMA_VERSION = 1 as const
export const PRESENTATION_VALIDATION_SCHEMA_VERSION = 1 as const

export type PresentationMode = 'published' | 'adaptive' | 'clean'

export type PresentationOperationKind =
  | 'remap-palette'
  | 'activate-author-theme'
  | 'restore-visible-text'
  | 'restore-explicit-text'
  | 'restore-list-marker'
  | 'restore-visible-stroke'
  | 'contain-overflow'
  | 'fit-wide-region'
  | 'preserve-media-aspect-ratio'
  | 'scale-fixed-viewport'
  | 'preserve-publication-paint'

export type PresentationTarget = {
  source: SourceTreeAddress
  pseudo?: 'before' | 'after' | 'marker'
  sourceSignature: string
}

export type PresentationFinding = {
  id: string
  analyzerId: string
  analyzerVersion: number
  kind: string
  confidence: number
  target?: PresentationTarget
  evidence: { [key: string]: CanonicalJsonValue }
}

export type PatchEffects = {
  paint: boolean
  geometry: 'none' | 'local' | 'section'
  semantics: 'none' | 'presentation-only'
}

export type InterventionCost = {
  semanticLoss: number
  sourceScope: number
  geometryImpact: number
  changedProperties: number
}

export type PresentationPatch = {
  id: string
  operationVersion: number
  target: PresentationTarget
  operation: PresentationOperationKind
  parameters: { [key: string]: CanonicalJsonValue }
  reasonFindingIds: string[]
  confidence: number
  reversible: true
  idempotent: true
  effects: PatchEffects
  cost: InterventionCost
  dependencies: string[]
  conflicts: string[]
}

export type PresentationPlanInput = {
  schemaVersion: typeof PRESENTATION_PLAN_SCHEMA_VERSION
  engineVersion: string
  mode: PresentationMode
  publicationRevision: string
  analysisFingerprint: string
  renderingContextFingerprint: string
  findings: PresentationFinding[]
  patches: PresentationPatch[]
}

export type PresentationPlanBody = PresentationPlanInput & {
  paintPlanHash: string
  geometryPlanHash: string
}

export type PresentationPlan = PresentationPlanBody & {
  planHash: string
}

export type ProbeResult = {
  id: string
  probeVersion: number
  passed: boolean
  confidence: number
  metrics: { [key: string]: CanonicalJsonValue }
}

export type ValidationFailure = {
  code: string
  findingIds: string[]
  patchIds: string[]
}

export type ValidationRecord = {
  schemaVersion: typeof PRESENTATION_VALIDATION_SCHEMA_VERSION
  validatorVersion: number
  validatedPlanHash: string
  passed: boolean
  confidence: number
  probes: ProbeResult[]
  geometryStable: boolean
  failureReasons: ValidationFailure[]
}

export type PresentationOperationValidator = (
  parameters: { [key: string]: CanonicalJsonValue },
  patch: PresentationPatch,
) => boolean

export type PresentationOperationValidators = Partial<
  Record<PresentationOperationKind, PresentationOperationValidator>
>

export type PresentationPlanIssue = {
  code: string
  path: string
}

export class InvalidPresentationPlanError extends Error {
  constructor(readonly issues: PresentationPlanIssue[]) {
    super(`Presentation plan is invalid (${issues.length} issue(s))`)
    this.name = 'InvalidPresentationPlanError'
  }
}

const OPERATIONS = new Set<PresentationOperationKind>([
  'remap-palette',
  'activate-author-theme',
  'restore-visible-text',
  'restore-explicit-text',
  'restore-list-marker',
  'restore-visible-stroke',
  'contain-overflow',
  'fit-wide-region',
  'preserve-media-aspect-ratio',
  'scale-fixed-viewport',
  'preserve-publication-paint',
])

const MODES = new Set<PresentationMode>(['published', 'adaptive', 'clean'])
const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/

function validUnitInterval(value: unknown): value is number {
  return typeof value === 'number' && value >= 0 && value <= 1
}

function validNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function validPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0
}

function validIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function validHash(value: unknown): value is string {
  return typeof value === 'string' && HASH_PATTERN.test(value)
}

function addIssue(
  issues: PresentationPlanIssue[],
  code: string,
  path: string,
): void {
  issues.push({ code, path })
}

function validateTarget(
  target: PresentationTarget,
  path: string,
  issues: PresentationPlanIssue[],
): void {
  if (!target || typeof target !== 'object') {
    addIssue(issues, 'invalid-target', path)
    return
  }
  const source = target.source
  if (
    !source ||
    source.sourceModelVersion !== SOURCE_TREE_MODEL_VERSION ||
    !Number.isInteger(source.spineIndex) ||
    source.spineIndex < 0 ||
    (source.nodeKind !== 'element' && source.nodeKind !== 'text') ||
    !Array.isArray(source.sourcePath) ||
    source.sourcePath.some((index) => !Number.isInteger(index) || index < 0)
  ) {
    addIssue(issues, 'invalid-source-address', `${path}.source`)
  }
  if (
    target.pseudo !== undefined &&
    target.pseudo !== 'before' &&
    target.pseudo !== 'after' &&
    target.pseudo !== 'marker'
  ) {
    addIssue(issues, 'invalid-pseudo-target', `${path}.pseudo`)
  }
  if (!validHash(target.sourceSignature)) {
    addIssue(issues, 'invalid-source-signature', `${path}.sourceSignature`)
  }
}

function validateFinding(
  finding: PresentationFinding,
  index: number,
  issues: PresentationPlanIssue[],
): void {
  const path = `findings[${index}]`
  if (!validIdentifier(finding?.id))
    addIssue(issues, 'invalid-id', `${path}.id`)
  if (!validIdentifier(finding?.analyzerId)) {
    addIssue(issues, 'invalid-analyzer', `${path}.analyzerId`)
  }
  if (!validPositiveInteger(finding?.analyzerVersion)) {
    addIssue(issues, 'invalid-version', `${path}.analyzerVersion`)
  }
  if (!validIdentifier(finding?.kind)) {
    addIssue(issues, 'invalid-finding-kind', `${path}.kind`)
  }
  if (!validUnitInterval(finding?.confidence)) {
    addIssue(issues, 'invalid-confidence', `${path}.confidence`)
  }
  if (finding?.target) validateTarget(finding.target, `${path}.target`, issues)
  try {
    canonicalJson(finding?.evidence)
  } catch {
    addIssue(issues, 'non-canonical-evidence', `${path}.evidence`)
  }
}

function validatePatch(
  patch: PresentationPatch,
  index: number,
  findingIds: Set<string>,
  validators: PresentationOperationValidators,
  issues: PresentationPlanIssue[],
): void {
  const path = `patches[${index}]`
  if (!validIdentifier(patch?.id)) addIssue(issues, 'invalid-id', `${path}.id`)
  if (!validPositiveInteger(patch?.operationVersion)) {
    addIssue(issues, 'invalid-version', `${path}.operationVersion`)
  }
  validateTarget(patch?.target, `${path}.target`, issues)
  if (!OPERATIONS.has(patch?.operation)) {
    addIssue(issues, 'unknown-operation', `${path}.operation`)
  }
  try {
    canonicalJson(patch?.parameters)
  } catch {
    addIssue(issues, 'non-canonical-parameters', `${path}.parameters`)
  }
  if (!Array.isArray(patch?.reasonFindingIds)) {
    addIssue(issues, 'invalid-finding-references', `${path}.reasonFindingIds`)
  } else {
    patch.reasonFindingIds.forEach((id, reasonIndex) => {
      if (!findingIds.has(id)) {
        addIssue(
          issues,
          'unknown-finding',
          `${path}.reasonFindingIds[${reasonIndex}]`,
        )
      }
    })
  }
  if (!validUnitInterval(patch?.confidence)) {
    addIssue(issues, 'invalid-confidence', `${path}.confidence`)
  }
  if (patch?.reversible !== true) {
    addIssue(issues, 'patch-not-reversible', `${path}.reversible`)
  }
  if (patch?.idempotent !== true) {
    addIssue(issues, 'patch-not-idempotent', `${path}.idempotent`)
  }
  if (
    typeof patch?.effects?.paint !== 'boolean' ||
    !['none', 'local', 'section'].includes(patch?.effects?.geometry) ||
    !['none', 'presentation-only'].includes(patch?.effects?.semantics)
  ) {
    addIssue(issues, 'invalid-effects', `${path}.effects`)
  }
  const cost = patch?.cost
  if (
    !cost ||
    !validNonNegativeNumber(cost.semanticLoss) ||
    !validNonNegativeNumber(cost.sourceScope) ||
    !validNonNegativeNumber(cost.geometryImpact) ||
    !validNonNegativeNumber(cost.changedProperties)
  ) {
    addIssue(issues, 'invalid-cost', `${path}.cost`)
  }
  if (!Array.isArray(patch?.dependencies)) {
    addIssue(issues, 'invalid-dependencies', `${path}.dependencies`)
  }
  if (!Array.isArray(patch?.conflicts)) {
    addIssue(issues, 'invalid-conflicts', `${path}.conflicts`)
  }

  const validator = validators[patch?.operation]
  if (!validator) {
    addIssue(issues, 'missing-operation-validator', `${path}.operation`)
  } else {
    try {
      if (!validator(patch.parameters, patch)) {
        addIssue(issues, 'invalid-operation-parameters', `${path}.parameters`)
      }
    } catch {
      addIssue(issues, 'operation-validator-failed', `${path}.parameters`)
    }
  }
}

function validatePatchGraph(
  patches: PresentationPatch[],
  issues: PresentationPlanIssue[],
): void {
  const indexes = new Map<string, number>()
  patches.forEach((patch, index) => {
    if (validIdentifier(patch?.id)) indexes.set(patch.id, index)
  })

  patches.forEach((patch, index) => {
    patch?.dependencies?.forEach((dependency, dependencyIndex) => {
      const dependencyPosition = indexes.get(dependency)
      const path = `patches[${index}].dependencies[${dependencyIndex}]`
      if (dependencyPosition === undefined) {
        addIssue(issues, 'unknown-dependency', path)
      } else if (dependencyPosition >= index) {
        addIssue(issues, 'dependency-order', path)
      }
    })
    patch?.conflicts?.forEach((conflict, conflictIndex) => {
      const path = `patches[${index}].conflicts[${conflictIndex}]`
      if (!indexes.has(conflict)) {
        addIssue(issues, 'unknown-conflict', path)
      } else {
        addIssue(issues, 'active-conflict', path)
      }
    })
  })

  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (id: string): void => {
    if (visiting.has(id)) {
      addIssue(issues, 'dependency-cycle', `patches.${id}`)
      return
    }
    if (visited.has(id)) return
    visiting.add(id)
    const patch = patches[indexes.get(id)!]
    patch?.dependencies?.forEach((dependency) => {
      if (indexes.has(dependency)) visit(dependency)
    })
    visiting.delete(id)
    visited.add(id)
  }
  patches.forEach((patch) => {
    if (validIdentifier(patch?.id)) visit(patch.id)
  })
}

export function validatePresentationPlanInput(
  input: PresentationPlanInput,
  validators: PresentationOperationValidators = {},
): PresentationPlanIssue[] {
  const issues: PresentationPlanIssue[] = []
  if (input?.schemaVersion !== PRESENTATION_PLAN_SCHEMA_VERSION) {
    addIssue(issues, 'unsupported-schema', 'schemaVersion')
  }
  for (const key of [
    'engineVersion',
    'publicationRevision',
    'analysisFingerprint',
    'renderingContextFingerprint',
  ] as const) {
    if (!validIdentifier(input?.[key])) addIssue(issues, 'invalid-id', key)
  }
  if (!MODES.has(input?.mode)) addIssue(issues, 'invalid-mode', 'mode')
  if (!Array.isArray(input?.findings)) {
    addIssue(issues, 'invalid-findings', 'findings')
    return issues
  }
  if (!Array.isArray(input?.patches)) {
    addIssue(issues, 'invalid-patches', 'patches')
    return issues
  }
  if (input.mode === 'published' && input.patches.length > 0) {
    addIssue(issues, 'published-plan-has-patches', 'patches')
  }

  const findingIds = new Set<string>()
  input.findings.forEach((finding, index) => {
    validateFinding(finding, index, issues)
    const id = finding?.id
    if (!validIdentifier(id)) return
    if (findingIds.has(id)) {
      addIssue(issues, 'duplicate-finding-id', `findings[${index}].id`)
    }
    findingIds.add(id)
  })
  const patchIds = new Set<string>()
  input.patches.forEach((patch, index) => {
    validatePatch(patch, index, findingIds, validators, issues)
    const id = patch?.id
    if (!validIdentifier(id)) return
    if (patchIds.has(id)) {
      addIssue(issues, 'duplicate-patch-id', `patches[${index}].id`)
    }
    patchIds.add(id)
  })
  validatePatchGraph(input.patches, issues)
  try {
    canonicalJson(input)
  } catch {
    addIssue(issues, 'non-canonical-plan', '$')
  }
  return issues
}

function patchHashIdentity(patch: PresentationPatch): CanonicalJsonValue {
  return {
    id: patch.id,
    operation: patch.operation,
    operationVersion: patch.operationVersion,
    target: patch.target as unknown as CanonicalJsonValue,
    parameters: patch.parameters,
    effects: patch.effects as unknown as CanonicalJsonValue,
  }
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value))
    return value
  Object.freeze(value)
  Object.values(value as Record<string, unknown>).forEach((child) =>
    deepFreeze(child),
  )
  return value
}

function canonicalClone<T>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T
}

/**
 * Build immutable local plan identities. Undefined means Web Crypto is not
 * available; the caller must keep the result uncacheable and use Published.
 */
export async function createPresentationPlan(
  input: PresentationPlanInput,
  validators: PresentationOperationValidators = {},
): Promise<PresentationPlan | undefined> {
  const issues = validatePresentationPlanInput(input, validators)
  if (issues.length > 0) throw new InvalidPresentationPlanError(issues)

  const stableInput = canonicalClone(input)
  const paintOperations = stableInput.patches
    .filter((patch) => patch.effects.paint && patch.effects.geometry === 'none')
    .map(patchHashIdentity)
  const geometryOperations = stableInput.patches
    .filter((patch) => patch.effects.geometry !== 'none')
    .map(patchHashIdentity)
  const [paintPlanHash, geometryPlanHash] = await Promise.all([
    hashCanonicalJson(paintOperations),
    hashCanonicalJson(geometryOperations),
  ])
  if (!paintPlanHash || !geometryPlanHash) return undefined

  const body: PresentationPlanBody = {
    ...stableInput,
    paintPlanHash,
    geometryPlanHash,
  }
  const planHash = await hashCanonicalJson(body)
  if (!planHash) return undefined
  return deepFreeze({ ...body, planHash })
}

export type ValidationRecordInput = Omit<
  ValidationRecord,
  'schemaVersion' | 'validatedPlanHash'
>

export function createValidationRecord(
  plan: PresentationPlan,
  input: ValidationRecordInput,
): ValidationRecord {
  const record = canonicalClone({
    schemaVersion: PRESENTATION_VALIDATION_SCHEMA_VERSION,
    validatorVersion: input.validatorVersion,
    validatedPlanHash: plan.planHash,
    passed: input.passed,
    confidence: input.confidence,
    probes: input.probes,
    geometryStable: input.geometryStable,
    failureReasons: input.failureReasons,
  })
  const reasons = validateValidationRecord(record)
  if (reasons.length > 0) {
    throw new TypeError(`Validation record is invalid: ${reasons.join(', ')}`)
  }
  return deepFreeze(record)
}

export type PresentationAdmissionContext = {
  engineVersion: string
  publicationRevision: string
  analysisFingerprint: string
  renderingContextFingerprint: string
  validators?: PresentationOperationValidators
}

export type AcceptedPresentationPlan = {
  plan: PresentationPlan
  validation: ValidationRecord
}

export type PresentationAdmissionResult =
  | { accepted: true; value: AcceptedPresentationPlan }
  | { accepted: false; reasons: string[] }

function validateValidationRecord(record: ValidationRecord): string[] {
  const reasons: string[] = []
  if (record?.schemaVersion !== PRESENTATION_VALIDATION_SCHEMA_VERSION) {
    reasons.push('unsupported-validation-schema')
  }
  if (!validPositiveInteger(record?.validatorVersion)) {
    reasons.push('invalid-validator-version')
  }
  if (!validHash(record?.validatedPlanHash)) reasons.push('invalid-plan-hash')
  if (typeof record?.passed !== 'boolean') reasons.push('invalid-pass-state')
  if (!validUnitInterval(record?.confidence)) reasons.push('invalid-confidence')
  if (!Array.isArray(record?.probes)) {
    reasons.push('invalid-probes')
  } else {
    const probeIds = new Set<string>()
    record.probes.forEach((probe) => {
      if (
        !validIdentifier(probe?.id) ||
        !validPositiveInteger(probe?.probeVersion) ||
        typeof probe?.passed !== 'boolean' ||
        !validUnitInterval(probe?.confidence)
      ) {
        reasons.push('invalid-probe')
      }
      if (probeIds.has(probe?.id)) reasons.push('duplicate-probe-id')
      probeIds.add(probe?.id)
      try {
        canonicalJson(probe?.metrics)
      } catch {
        reasons.push('non-canonical-probe-metrics')
      }
    })
  }
  if (typeof record?.geometryStable !== 'boolean') {
    reasons.push('invalid-geometry-state')
  }
  if (!Array.isArray(record?.failureReasons)) {
    reasons.push('invalid-failure-reasons')
  } else {
    record.failureReasons.forEach((failure) => {
      if (
        !validIdentifier(failure?.code) ||
        !Array.isArray(failure?.findingIds) ||
        failure.findingIds.some((id) => !validIdentifier(id)) ||
        !Array.isArray(failure?.patchIds) ||
        failure.patchIds.some((id) => !validIdentifier(id))
      ) {
        reasons.push('invalid-failure-reason')
      }
    })
  }
  try {
    canonicalJson(record)
  } catch {
    reasons.push('non-canonical-validation')
  }
  return reasons
}

/** Validation is an admission gate, never a score or best-effort hint. */
export async function admitPresentationPlan(
  plan: PresentationPlan,
  validation: ValidationRecord,
  context: PresentationAdmissionContext,
): Promise<PresentationAdmissionResult> {
  const reasons = validateValidationRecord(validation)
  if (plan.engineVersion !== context.engineVersion) {
    reasons.push('stale-engine')
  }
  if (plan.publicationRevision !== context.publicationRevision) {
    reasons.push('stale-publication')
  }
  if (plan.analysisFingerprint !== context.analysisFingerprint) {
    reasons.push('stale-analysis')
  }
  if (
    plan.renderingContextFingerprint !== context.renderingContextFingerprint
  ) {
    reasons.push('stale-rendering-context')
  }
  if (validation.validatedPlanHash !== plan.planHash) {
    reasons.push('validation-plan-mismatch')
  }
  if (!validation.passed) reasons.push('validation-failed')
  if (!validation.geometryStable) reasons.push('geometry-unstable')
  if (validation.probes?.some((probe) => !probe.passed)) {
    reasons.push('probe-failed')
  }
  if (validation.failureReasons?.length > 0) {
    reasons.push('validation-has-failures')
  }

  try {
    const {
      planHash: _planHash,
      paintPlanHash: _paintPlanHash,
      geometryPlanHash: _geometryPlanHash,
      ...input
    } = plan
    const rebuilt = await createPresentationPlan(
      input,
      context.validators ?? {},
    )
    if (!rebuilt) {
      reasons.push('hash-unavailable')
    } else if (
      rebuilt.planHash !== plan.planHash ||
      rebuilt.paintPlanHash !== plan.paintPlanHash ||
      rebuilt.geometryPlanHash !== plan.geometryPlanHash
    ) {
      reasons.push('plan-integrity-failed')
    }
  } catch {
    reasons.push('invalid-plan')
  }

  const uniqueReasons = [...new Set(reasons)]
  if (uniqueReasons.length > 0) {
    return { accepted: false, reasons: uniqueReasons }
  }
  return {
    accepted: true,
    value: deepFreeze({ plan, validation }),
  }
}

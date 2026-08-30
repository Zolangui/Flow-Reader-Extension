import { hashCanonicalJson, type CanonicalJsonValue } from './canonical-json'
import {
  parseSrgbColor,
  relativeLuminance,
  srgbToHex,
} from './presentation-color'
import {
  createPresentationHealthMap,
  MAX_PRESENTATION_HEALTH_ELEMENTS,
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
import { boundedNumber } from './presentation-options'
import { isPresentationRuntimeNode } from './presentation-marker'
import {
  createSourceNodeSignature,
  getSourceTreeRoot,
  resolveSourceTreeAddress,
  SOURCE_TREE_MODEL_VERSION,
  type SourceTreeAddress,
} from './source-tree'

export const AUTHOR_THEME_RESOLVER_VERSION = 4 as const
export const ACTIVATE_AUTHOR_THEME_OPERATION_VERSION = 1 as const
export const AUTHOR_THEME_VALIDATOR_VERSION = 3 as const

const ROOT_MARKER = 'data-lumen-author-theme'
const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/
const CSS_IMPORT_RULE = 3
const MAX_AUTHOR_THEME_STYLESHEETS = 64
const MAX_AUTHOR_THEME_RULES = 4096
const MAX_AUTHOR_THEME_RULE_DEPTH = 32
const MAX_AUTHOR_THEME_ELEMENTS = MAX_PRESENTATION_HEALTH_ELEMENTS
const MAX_AUTHOR_THEME_TEXT_SAMPLES = 512

export type AuthorColorScheme = 'light' | 'dark'

export type ActivateAuthorThemeParameters = {
  schemaVersion: 1
  targetScheme: AuthorColorScheme
  branchSetHash: string
  darkBranchCount: number
  lightBranchCount: number
  ambientSchemeMatch: boolean
  canvas: string
  minimumTextContrast: number
}

export type AuthorThemeAnalysisOptions = {
  sourceDocument: Document
  renderedDocument: Document
  spineIndex: number
  targetScheme: AuthorColorScheme
  canvasColor: string
  signal?: AbortSignal
  minimumTextContrast?: number
}

export type AuthorThemeAnalysis = {
  findings: PresentationFinding[]
  patches: PresentationPatch[]
  inspectedStyleSheets: number
  diagnostics: string[]
}

type ThemeBranchDescriptor = {
  path: string
  kind: 'stylesheet' | 'media-rule' | 'import-rule'
  scheme: AuthorColorScheme
  mediaText: string
}

type ThemeBranch = ThemeBranchDescriptor & {
  media: MediaList
}

type ThemeInspection = {
  branches: ThemeBranch[]
  inspectedStyleSheets: number
  blocked: boolean
  diagnostics: string[]
}

type ThemeMutation = {
  media: MediaList
  originalMediaText: string
  appliedMediaText: string
}

type ThemeSample = {
  element: Element
  color: string
  backgroundColor: string
}

type ThemeSnapshot = {
  samples: ThemeSample[]
  truncated: boolean
}

export type AppliedAuthorThemeLayer = {
  planHash: string
  document: Document
  parameters: ActivateAuthorThemeParameters
  spineIndex: number
  mutations: ThemeMutation[]
  before: ThemeSnapshot
  restore: () => void
}

export type AuthorThemeValidation = {
  input: ValidationRecordInput
  changedSampleCount: number
  inspectedTextSampleCount: number
}

const appliedLayers = new WeakMap<Document, AppliedAuthorThemeLayer>()

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

export function isActivateAuthorThemeParameters(
  value: unknown,
): value is ActivateAuthorThemeParameters {
  if (
    !isExactObject(value, [
      'schemaVersion',
      'targetScheme',
      'branchSetHash',
      'darkBranchCount',
      'lightBranchCount',
      'ambientSchemeMatch',
      'canvas',
      'minimumTextContrast',
    ])
  ) {
    return false
  }
  return (
    value.schemaVersion === 1 &&
    (value.targetScheme === 'light' || value.targetScheme === 'dark') &&
    typeof value.branchSetHash === 'string' &&
    HASH_PATTERN.test(value.branchSetHash) &&
    Number.isInteger(value.darkBranchCount) &&
    (value.darkBranchCount as number) >= 0 &&
    Number.isInteger(value.lightBranchCount) &&
    (value.lightBranchCount as number) >= 0 &&
    typeof value.ambientSchemeMatch === 'boolean' &&
    typeof value.canvas === 'string' &&
    (parseSrgbColor(value.canvas)?.a ?? 0) >= 0.999 &&
    typeof value.minimumTextContrast === 'number' &&
    Number.isFinite(value.minimumTextContrast) &&
    value.minimumTextContrast >= 1 &&
    value.minimumTextContrast <= 21
  )
}

export const AUTHOR_THEME_OPERATION_VALIDATORS: PresentationOperationValidators =
  {
    'activate-author-theme': (parameters, patch) =>
      isActivateAuthorThemeParameters(parameters) &&
      patch.operationVersion === ACTIVATE_AUTHOR_THEME_OPERATION_VERSION &&
      patch.effects.paint === true &&
      patch.effects.geometry === 'section' &&
      patch.effects.semantics === 'presentation-only',
  }

type MediaToken = string

/**
 * Tokenize the small, deliberately bounded media-query grammar accepted by
 * phase 7. CSS itself has already been parsed by the browser's CSSOM; this
 * tokenizer only classifies an exact color-scheme condition and never rewrites
 * selectors, declarations, or stylesheet source text.
 */
function tokenizeMediaQuery(value: string): MediaToken[] {
  const tokens: string[] = []
  let identifier = ''
  const flush = (): void => {
    if (!identifier) return
    tokens.push(identifier.toLowerCase())
    identifier = ''
  }
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0
    const identifierCharacter =
      (code >= 48 && code <= 57) ||
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      character === '-'
    if (identifierCharacter) {
      identifier += character
      continue
    }
    flush()
    if (character === '(' || character === ')' || character === ':') {
      tokens.push(character)
    } else if (character === ',') {
      tokens.push(',')
    } else if (!/\s/u.test(character)) {
      tokens.push(character)
    }
  }
  flush()
  return tokens
}

function splitMediaQueries(tokens: readonly string[]): string[][] {
  const queries: string[][] = [[]]
  let depth = 0
  for (const token of tokens) {
    if (token === '(') depth += 1
    if (token === ')') depth -= 1
    if (token === ',' && depth === 0) {
      queries.push([])
    } else {
      queries[queries.length - 1]!.push(token)
    }
  }
  return queries
}

function exactSchemeQuery(
  tokens: readonly string[],
): AuthorColorScheme | undefined {
  let offset = 0
  if (tokens[offset] === 'only') offset += 1
  if (tokens[offset] === 'screen' || tokens[offset] === 'all') {
    offset += 1
    if (tokens[offset] !== 'and') return undefined
    offset += 1
  }
  const feature = tokens.slice(offset)
  if (
    feature.length !== 5 ||
    feature[0] !== '(' ||
    feature[1] !== 'prefers-color-scheme' ||
    feature[2] !== ':' ||
    feature[4] !== ')' ||
    (feature[3] !== 'light' && feature[3] !== 'dark')
  ) {
    return undefined
  }
  return feature[3]
}

export function classifyAuthorColorSchemeMedia(
  mediaText: string,
):
  | { kind: 'none' }
  | { kind: 'scheme'; scheme: AuthorColorScheme }
  | { kind: 'unsupported' } {
  const tokens = tokenizeMediaQuery(mediaText)
  if (!tokens.includes('prefers-color-scheme')) return { kind: 'none' }
  const schemes = splitMediaQueries(tokens).map(exactSchemeQuery)
  if (
    schemes.length === 0 ||
    schemes.some((scheme) => !scheme) ||
    schemes.some((scheme) => scheme !== schemes[0])
  ) {
    return { kind: 'unsupported' }
  }
  return { kind: 'scheme', scheme: schemes[0]! }
}

function mediaList(value: unknown): MediaList | undefined {
  const candidate = (value as { media?: unknown } | undefined)?.media
  if (
    candidate &&
    typeof candidate === 'object' &&
    typeof (candidate as MediaList).mediaText === 'string'
  ) {
    return candidate as MediaList
  }
  return undefined
}

function nestedRules(value: unknown): CSSRuleList | undefined {
  const rules = (value as { cssRules?: unknown } | undefined)?.cssRules
  return rules && typeof rules === 'object' && 'length' in rules
    ? (rules as CSSRuleList)
    : undefined
}

function authorOwnedSheet(sheet: CSSStyleSheet, document: Document): boolean {
  const owner =
    sheet.ownerNode ??
    Array.from(
      document.querySelectorAll<HTMLStyleElement | HTMLLinkElement>(
        'style, link[rel~="stylesheet"]',
      ),
    ).find((candidate) => candidate.sheet === sheet)
  return !owner || !isPresentationRuntimeNode(owner)
}

function inspectAuthorTheme(
  document: Document,
  signal?: AbortSignal,
): ThemeInspection {
  const branches: ThemeBranch[] = []
  const diagnostics: string[] = []
  const seenSheets = new Set<CSSStyleSheet>()
  const seenMedia = new Set<MediaList>()
  let inspectedStyleSheets = 0
  let inspectedRules = 0
  let blocked = false

  const inspectMedia = (
    media: MediaList | undefined,
    path: string,
    kind: ThemeBranchDescriptor['kind'],
  ): void => {
    if (!media || seenMedia.has(media)) return
    seenMedia.add(media)
    const mediaText = media.mediaText
    const classification = classifyAuthorColorSchemeMedia(mediaText)
    if (classification.kind === 'unsupported') {
      blocked = true
      diagnostics.push(`unsupported-color-scheme-query:${path}`)
      return
    }
    if (classification.kind === 'scheme') {
      branches.push({
        path,
        kind,
        scheme: classification.scheme,
        mediaText,
        media,
      })
    }
  }

  const inspectRules = (
    rules: CSSRuleList,
    path: string,
    depth: number,
  ): void => {
    if (depth > MAX_AUTHOR_THEME_RULE_DEPTH) {
      blocked = true
      diagnostics.push(`cssom-depth-budget:${path}`)
      return
    }
    for (let index = 0; index < rules.length; index += 1) {
      throwIfAborted(signal)
      inspectedRules += 1
      if (inspectedRules > MAX_AUTHOR_THEME_RULES) {
        blocked = true
        diagnostics.push('cssom-rule-budget')
        return
      }
      const rule = rules[index]!
      const rulePath = `${path}/rule:${index}`
      inspectMedia(
        mediaList(rule),
        rulePath,
        rule.type === CSS_IMPORT_RULE ? 'import-rule' : 'media-rule',
      )
      if (rule.type === CSS_IMPORT_RULE) {
        const imported = (rule as CSSImportRule).styleSheet
        if (!imported) {
          blocked = true
          diagnostics.push(`unavailable-import:${rulePath}`)
        } else {
          inspectSheet(imported, `${rulePath}/import`)
        }
        continue
      }
      const children = nestedRules(rule)
      if (children) inspectRules(children, rulePath, depth + 1)
    }
  }

  const inspectSheet = (sheet: CSSStyleSheet, path: string): void => {
    if (seenSheets.has(sheet) || !authorOwnedSheet(sheet, document)) return
    seenSheets.add(sheet)
    inspectedStyleSheets += 1
    if (inspectedStyleSheets > MAX_AUTHOR_THEME_STYLESHEETS) {
      blocked = true
      diagnostics.push('cssom-stylesheet-budget')
      return
    }
    inspectMedia(mediaList(sheet), `${path}/media`, 'stylesheet')
    try {
      inspectRules(sheet.cssRules, path, 0)
    } catch {
      blocked = true
      diagnostics.push(`inaccessible-stylesheet:${path}`)
    }
  }

  const sheets = Array.from(document.styleSheets)
  for (let index = 0; index < sheets.length; index += 1) {
    throwIfAborted(signal)
    inspectSheet(sheets[index]!, `sheet:${index}`)
    if (blocked) break
  }
  return { branches, inspectedStyleSheets, blocked, diagnostics }
}

function branchDescriptors(
  branches: readonly ThemeBranch[],
): CanonicalJsonValue {
  return branches.map(({ path, kind, scheme, mediaText }) => ({
    path,
    kind,
    scheme,
    mediaText,
  }))
}

function sourceRootAddress(spineIndex: number): SourceTreeAddress {
  return {
    sourceModelVersion: SOURCE_TREE_MODEL_VERSION,
    spineIndex,
    nodeKind: 'element',
    sourcePath: [],
  }
}

export async function analyzeAuthorTheme(
  options: AuthorThemeAnalysisOptions,
): Promise<AuthorThemeAnalysis> {
  throwIfAborted(options.signal)
  const inspection = inspectAuthorTheme(
    options.renderedDocument,
    options.signal,
  )
  if (inspection.blocked) {
    return {
      findings: [],
      patches: [],
      inspectedStyleSheets: inspection.inspectedStyleSheets,
      diagnostics: inspection.diagnostics,
    }
  }
  const darkBranchCount = inspection.branches.filter(
    (branch) => branch.scheme === 'dark',
  ).length
  const lightBranchCount = inspection.branches.length - darkBranchCount
  const targetBranchCount =
    options.targetScheme === 'dark' ? darkBranchCount : lightBranchCount
  if (targetBranchCount === 0) {
    return {
      findings: [],
      patches: [],
      inspectedStyleSheets: inspection.inspectedStyleSheets,
      diagnostics: [
        ...inspection.diagnostics,
        `no-authored-${options.targetScheme}-branch`,
      ],
    }
  }
  const [branchSetHash, sourceSignature] = await Promise.all([
    hashCanonicalJson(branchDescriptors(inspection.branches)),
    createSourceNodeSignature(getSourceTreeRoot(options.sourceDocument)),
  ])
  throwIfAborted(options.signal)
  if (!branchSetHash || !sourceSignature) {
    return {
      findings: [],
      patches: [],
      inspectedStyleSheets: inspection.inspectedStyleSheets,
      diagnostics: [...inspection.diagnostics, 'strong-hash-unavailable'],
    }
  }
  const target = {
    source: sourceRootAddress(options.spineIndex),
    sourceSignature,
  }
  const suffix = branchSetHash.slice('sha256:'.length, 'sha256:'.length + 12)
  const findingId = `author-theme:${options.targetScheme}:${suffix}`
  const patchId = `activate-author-theme:${options.targetScheme}:${suffix}`
  const parameters: ActivateAuthorThemeParameters = {
    schemaVersion: 1,
    targetScheme: options.targetScheme,
    branchSetHash,
    darkBranchCount,
    lightBranchCount,
    ambientSchemeMatch:
      options.renderedDocument.defaultView?.matchMedia?.(
        `(prefers-color-scheme: ${options.targetScheme})`,
      ).matches ?? false,
    canvas: options.canvasColor,
    minimumTextContrast: boundedNumber(options.minimumTextContrast, 4.5, 1, 21),
  }
  return {
    findings: [
      {
        id: findingId,
        analyzerId: 'author-theme-resolver',
        analyzerVersion: AUTHOR_THEME_RESOLVER_VERSION,
        kind: 'authored-color-scheme-branches',
        confidence: 0.96,
        target,
        evidence: {
          targetScheme: options.targetScheme,
          branchSetHash,
          darkBranchCount,
          lightBranchCount,
          ambientSchemeMatch: parameters.ambientSchemeMatch,
          inspectedStyleSheets: inspection.inspectedStyleSheets,
        },
      },
    ],
    patches: [
      {
        id: patchId,
        operationVersion: ACTIVATE_AUTHOR_THEME_OPERATION_VERSION,
        target,
        operation: 'activate-author-theme',
        parameters: parameters as unknown as {
          [key: string]: CanonicalJsonValue
        },
        reasonFindingIds: [findingId],
        confidence: 0.96,
        reversible: true,
        idempotent: true,
        effects: {
          paint: true,
          geometry: 'section',
          semantics: 'presentation-only',
        },
        cost: {
          semanticLoss: 0,
          sourceScope: 1,
          geometryImpact: 0.5,
          changedProperties: inspection.branches.length,
        },
        dependencies: [],
        conflicts: [],
      },
    ],
    inspectedStyleSheets: inspection.inspectedStyleSheets,
    diagnostics: inspection.diagnostics,
  }
}

function captureThemeSnapshot(
  document: Document,
  canvas: string,
  spineIndex: number,
  signal?: AbortSignal,
): ThemeSnapshot {
  const health = createPresentationHealthMap({
    renderedDocument: document,
    spineIndex,
    canvasColor: canvas,
    signal,
    maxInspectedElements: MAX_AUTHOR_THEME_ELEMENTS,
  })
  const eligible = health.observations.flatMap((observation): ThemeSample[] =>
    observation.directMeaningfulText &&
    observation.textPaintEligible &&
    observation.paint.kind === 'known'
      ? [
          {
            element: observation.element,
            color: srgbToHex(observation.paint.foreground),
            backgroundColor: srgbToHex(observation.paint.background),
          },
        ]
      : [],
  )
  return {
    samples: eligible.slice(0, MAX_AUTHOR_THEME_TEXT_SAMPLES),
    truncated:
      health.truncated || eligible.length > MAX_AUTHOR_THEME_TEXT_SAMPLES,
  }
}

function mediaTarget(
  parameters: ActivateAuthorThemeParameters,
  scheme: AuthorColorScheme,
): string {
  return scheme === parameters.targetScheme ? 'all' : 'not all'
}

export async function applyAuthorThemePlan(
  plan: PresentationPlan,
  sourceDocument: Document,
  renderedDocument: Document,
  spineIndex: number,
  signal?: AbortSignal,
): Promise<AppliedAuthorThemeLayer | undefined> {
  restoreAuthorThemeLayer(renderedDocument)
  const patch = plan.patches.find(
    (candidate) => candidate.operation === 'activate-author-theme',
  )
  if (!patch) return undefined
  if (
    patch.operationVersion !== ACTIVATE_AUTHOR_THEME_OPERATION_VERSION ||
    patch.effects.paint !== true ||
    patch.effects.geometry !== 'section' ||
    patch.effects.semantics !== 'presentation-only' ||
    !isActivateAuthorThemeParameters(patch.parameters)
  ) {
    throw new TypeError('Invalid author theme parameters')
  }
  const sourceNode = resolveSourceTreeAddress(
    sourceDocument,
    patch.target.source,
    spineIndex,
  )
  if (!sourceNode || sourceNode.nodeType !== 1) {
    throw new Error('Author theme source target is stale')
  }
  const signature = await createSourceNodeSignature(sourceNode)
  throwIfAborted(signal)
  if (!signature || signature !== patch.target.sourceSignature) {
    throw new Error('Author theme source signature is stale')
  }

  const inspection = inspectAuthorTheme(renderedDocument, signal)
  if (inspection.blocked) throw new Error('Author theme CSSOM is incomplete')
  const fingerprint = await hashCanonicalJson(
    branchDescriptors(inspection.branches),
  )
  throwIfAborted(signal)
  const darkBranchCount = inspection.branches.filter(
    (branch) => branch.scheme === 'dark',
  ).length
  const lightBranchCount = inspection.branches.length - darkBranchCount
  if (
    !fingerprint ||
    fingerprint !== patch.parameters.branchSetHash ||
    darkBranchCount !== patch.parameters.darkBranchCount ||
    lightBranchCount !== patch.parameters.lightBranchCount
  ) {
    throw new Error('Author theme branch set is stale')
  }

  const before = captureThemeSnapshot(
    renderedDocument,
    patch.parameters.canvas,
    spineIndex,
    signal,
  )
  if (before.truncated) {
    throw new Error('Author theme validation sample is truncated')
  }
  const root = renderedDocument.documentElement
  const previousMarker = root.getAttribute(ROOT_MARKER)
  const mutations: ThemeMutation[] = []
  let restored = false
  const restore = (): void => {
    if (restored) return
    restored = true
    for (let index = mutations.length - 1; index >= 0; index -= 1) {
      const mutation = mutations[index]!
      try {
        mutation.media.mediaText = mutation.originalMediaText
      } catch {
        // Continue restoring every authored branch if one stylesheet vanished.
      }
    }
    if (previousMarker === null) root.removeAttribute(ROOT_MARKER)
    else root.setAttribute(ROOT_MARKER, previousMarker)
    if (appliedLayers.get(renderedDocument)?.restore === restore) {
      appliedLayers.delete(renderedDocument)
    }
  }

  try {
    for (const branch of inspection.branches) {
      throwIfAborted(signal)
      const appliedMediaText = mediaTarget(patch.parameters, branch.scheme)
      mutations.push({
        media: branch.media,
        originalMediaText: branch.media.mediaText,
        appliedMediaText,
      })
      branch.media.mediaText = appliedMediaText
      if (branch.media.mediaText !== appliedMediaText) {
        throw new Error('Browser refused author theme media activation')
      }
    }
    root.setAttribute(ROOT_MARKER, patch.parameters.targetScheme)
    const layer: AppliedAuthorThemeLayer = {
      planHash: plan.planHash,
      document: renderedDocument,
      parameters: patch.parameters,
      spineIndex,
      mutations,
      before,
      restore,
    }
    appliedLayers.set(renderedDocument, layer)
    return layer
  } catch (error) {
    restore()
    throw error
  }
}

export function restoreAuthorThemeLayer(document: Document): boolean {
  const layer = appliedLayers.get(document)
  if (!layer) return false
  layer.restore()
  return true
}

function frame(document: Document, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal)
  const contentView = document.defaultView
  let scheduler = contentView
  try {
    // Firefox can heavily throttle requestAnimationFrame inside an off-screen
    // measurement iframe. Schedule against its visible owner document when
    // available; the geometry reads below still flush the measured document.
    scheduler =
      contentView?.frameElement?.ownerDocument.defaultView ?? contentView
  } catch {
    // Cross-origin frame access is not required for correctness.
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
    const complete = (): void => {
      if (settled) return
      settled = true
      cleanup()
      resolve()
    }
    const cleanup = (): void => {
      signal?.removeEventListener('abort', onAbort)
      if (frameId !== undefined && scheduler?.cancelAnimationFrame) {
        scheduler.cancelAnimationFrame(frameId)
      }
      if (timerId !== undefined) globalThis.clearTimeout(timerId)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    if (scheduler?.requestAnimationFrame) {
      frameId = scheduler.requestAnimationFrame(complete)
      timerId = globalThis.setTimeout(complete, 100)
    } else if (scheduler) {
      timerId = globalThis.setTimeout(complete, 0)
    } else {
      queueMicrotask(complete)
    }
  })
}

function geometryKey(layer: AppliedAuthorThemeLayer): string {
  const root = layer.document.documentElement
  const body = layer.document.body
  const metric = (value: number): number =>
    Number.isFinite(value) ? Math.round(value * 100) / 100 : 0
  return [
    root?.scrollWidth ?? 0,
    root?.scrollHeight ?? 0,
    body?.scrollWidth ?? 0,
    body?.scrollHeight ?? 0,
    ...layer.before.samples.flatMap(({ element }) => {
      const rect = element.getBoundingClientRect()
      return [
        metric(rect.x),
        metric(rect.y),
        metric(rect.width),
        metric(rect.height),
      ]
    }),
  ].join(':')
}

async function waitForAuthorFonts(
  document: Document,
  signal?: AbortSignal,
): Promise<boolean> {
  const ready = (
    document as Document & { fonts?: { ready?: Promise<unknown> } }
  ).fonts?.ready
  if (!ready) return true
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
    void ready.then(
      () => finish(true),
      // A rejected font load has selected browser fallback metrics and is
      // therefore settled; a timeout is the uncertain state.
      () => finish(true),
    )
  })
}

export async function waitForAuthorThemeGeometryStability(
  layer: AppliedAuthorThemeLayer,
  signal?: AbortSignal,
): Promise<boolean> {
  // Trigger style/font selection before observing the FontFaceSet promise.
  await frame(layer.document, signal)
  if (!(await waitForAuthorFonts(layer.document, signal))) return false
  let previous = geometryKey(layer)
  let stableReadings = 0
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await frame(layer.document, signal)
    throwIfAborted(signal)
    const current = geometryKey(layer)
    stableReadings = current === previous ? stableReadings + 1 : 0
    if (stableReadings >= 2) return true
    previous = current
  }
  return false
}

export function validateAppliedAuthorTheme(
  layer: AppliedAuthorThemeLayer,
  geometryStable: boolean,
): AuthorThemeValidation {
  const probes: ProbeResult[] = []
  const failures: ValidationFailure[] = []
  const fail = (code: string): void => {
    failures.push({
      code,
      findingIds: [],
      patchIds: [],
    })
  }

  const mutationState = layer.mutations.every(
    (mutation) => mutation.media.mediaText === mutation.appliedMediaText,
  )
  probes.push({
    id: 'author-theme-media-state',
    probeVersion: AUTHOR_THEME_VALIDATOR_VERSION,
    passed: mutationState,
    confidence: mutationState ? 1 : 0,
    metrics: { mutatedBranches: layer.mutations.length },
  })
  if (!mutationState) fail('author-theme-media-state-lost')

  let changedSampleCount = 0
  let inspectedTextSampleCount = 0
  let contrastPassed = true
  let schemeSurfacePassed = false
  let afterTruncated = false
  if (layer.document.defaultView) {
    const health = createPresentationHealthMap({
      renderedDocument: layer.document,
      spineIndex: layer.spineIndex,
      canvasColor: layer.parameters.canvas,
      maxInspectedElements: MAX_AUTHOR_THEME_ELEMENTS,
    })
    const afterText = health.observations.filter(
      (observation) =>
        observation.directMeaningfulText && observation.textPaintEligible,
    )
    afterTruncated =
      health.truncated ||
      afterText.length + health.listMarkers.length >
        MAX_AUTHOR_THEME_TEXT_SAMPLES
    const byElement = new WeakMap<Element, PresentationHealthObservation>()
    health.observations.forEach((observation) =>
      byElement.set(observation.element, observation),
    )
    for (const observation of afterText.slice(
      0,
      MAX_AUTHOR_THEME_TEXT_SAMPLES,
    )) {
      inspectedTextSampleCount += 1
      if (
        observation.paint.kind !== 'known' ||
        observation.paint.contrast < layer.parameters.minimumTextContrast
      ) {
        contrastPassed = false
      }
    }
    const remainingMarkerSamples = Math.max(
      0,
      MAX_AUTHOR_THEME_TEXT_SAMPLES - inspectedTextSampleCount,
    )
    for (const marker of health.listMarkers.slice(0, remainingMarkerSamples)) {
      inspectedTextSampleCount += 1
      if (
        marker.paint.kind !== 'known' ||
        marker.paint.contrast < layer.parameters.minimumTextContrast
      ) {
        contrastPassed = false
      }
    }
    for (const sample of layer.before.samples) {
      const observation = byElement.get(sample.element)
      if (!observation || observation.paint.kind !== 'known') {
        contrastPassed = false
        continue
      }
      const color = srgbToHex(observation.paint.foreground)
      const backgroundColor = srgbToHex(observation.paint.background)
      if (
        color !== sample.color ||
        backgroundColor !== sample.backgroundColor
      ) {
        changedSampleCount += 1
      }
    }
    const surfaceElement = layer.document.body ?? layer.document.documentElement
    const surface = byElement.get(surfaceElement)
    if (surface?.paint.kind === 'known') {
      const luminance = relativeLuminance(surface.paint.background)
      schemeSurfacePassed =
        layer.parameters.targetScheme === 'dark'
          ? luminance <= 0.35
          : luminance >= 0.55
    }
  }
  if (afterTruncated) fail('author-theme-health-map-truncated')

  const changed =
    changedSampleCount > 0 ||
    (layer.parameters.ambientSchemeMatch && schemeSurfacePassed)
  probes.push({
    id: 'author-theme-paint-change',
    probeVersion: AUTHOR_THEME_VALIDATOR_VERSION,
    passed: changed,
    confidence: changed ? 0.96 : 0,
    metrics: { changedSampleCount },
  })
  if (!changed) fail('author-theme-no-observable-paint-change')

  const readable =
    inspectedTextSampleCount > 0 && contrastPassed && !afterTruncated
  probes.push({
    id: 'author-theme-text-contrast',
    probeVersion: AUTHOR_THEME_VALIDATOR_VERSION,
    passed: readable,
    confidence: readable ? 0.94 : 0,
    metrics: {
      inspectedTextSampleCount,
      minimumTextContrast: layer.parameters.minimumTextContrast,
    },
  })
  if (!readable) fail('author-theme-contrast-unproven')

  probes.push({
    id: 'author-theme-surface-scheme',
    probeVersion: AUTHOR_THEME_VALIDATOR_VERSION,
    passed: schemeSurfacePassed,
    confidence: schemeSurfacePassed ? 0.94 : 0,
    metrics: { targetScheme: layer.parameters.targetScheme },
  })
  if (!schemeSurfacePassed) fail('author-theme-surface-scheme-mismatch')

  probes.push({
    id: 'author-theme-geometry-stability',
    probeVersion: AUTHOR_THEME_VALIDATOR_VERSION,
    passed: geometryStable,
    confidence: geometryStable ? 0.95 : 0,
    metrics: {},
  })
  if (!geometryStable) fail('author-theme-geometry-unstable')

  const passed = failures.length === 0
  return {
    input: {
      validatorVersion: AUTHOR_THEME_VALIDATOR_VERSION,
      passed,
      confidence: passed ? 0.94 : 1,
      probes,
      geometryStable,
      failureReasons: failures,
    },
    changedSampleCount,
    inspectedTextSampleCount,
  }
}

export const PRESENTATION_RUN_VERSION = 1 as const

export type PresentationRunState =
  | 'idle'
  | 'inspecting'
  | 'probing'
  | 'planning'
  | 'paginating'
  | 'validating'
  | 'ready'
  | 'cancelled'
  | 'rejected'
  | 'fallback'

export type PresentationRunIdentity = {
  generation: number
  publicationRevision: string
  spineIndex: number
  analysisFingerprint: string
  renderingContextFingerprint: string
}

export type PresentationRunInput = Omit<PresentationRunIdentity, 'generation'>

export type PresentationRunBudget = {
  maxCandidates: number
  maxIterations: number
  maxElapsedMs: number
  maxDiagnostics: number
}

export type PresentationDiagnosticEvent = {
  sequence: number
  timestamp: number
  state: PresentationRunState
  code: string
}

export const DEFAULT_PRESENTATION_RUN_BUDGET: PresentationRunBudget = {
  maxCandidates: 16,
  maxIterations: 4,
  // Complete validation of a large index takes about two seconds in isolation,
  // but reader and Atlas work can contend for the same browser process. This is
  // a cancellation ceiling, not an artificial delay for ordinary chapters.
  maxElapsedMs: 8000,
  maxDiagnostics: 64,
}

const TRANSITIONS: Readonly<
  Record<PresentationRunState, PresentationRunState[]>
> = {
  idle: ['inspecting', 'cancelled'],
  inspecting: ['probing', 'planning', 'fallback', 'cancelled'],
  probing: ['planning', 'fallback', 'cancelled'],
  planning: ['paginating', 'rejected', 'fallback', 'cancelled'],
  // A post-pagination analyzer may prove a defect that was not observable
  // before fragmentation. It may return to planning within the same budget.
  paginating: ['planning', 'validating', 'rejected', 'fallback', 'cancelled'],
  validating: ['ready', 'rejected', 'fallback', 'cancelled'],
  // A rejected candidate may be revised within the bounded iteration budget.
  rejected: ['planning', 'fallback', 'cancelled'],
  ready: [],
  cancelled: [],
  fallback: [],
}

export class PresentationRunCancelledError extends Error {
  constructor() {
    super('Presentation run is cancelled or stale')
    this.name = 'AbortError'
  }
}

export class PresentationRunBudgetError extends Error {
  constructor(readonly budget: keyof PresentationRunBudget) {
    super(`Presentation run exceeded ${budget}`)
    this.name = 'PresentationRunBudgetError'
  }
}

function validateBudget(budget: PresentationRunBudget): void {
  for (const [key, value] of Object.entries(budget)) {
    const requiresInteger = key !== 'maxElapsedMs'
    if (
      !Number.isFinite(value) ||
      value < 0 ||
      (requiresInteger && !Number.isInteger(value))
    ) {
      throw new RangeError(`Invalid presentation budget: ${key}`)
    }
  }
}

function validateIdentity(identity: PresentationRunIdentity): void {
  if (!Number.isInteger(identity.generation) || identity.generation <= 0) {
    throw new RangeError('Presentation generation must be a positive integer')
  }
  if (!Number.isInteger(identity.spineIndex) || identity.spineIndex < 0) {
    throw new RangeError('Presentation spineIndex must be non-negative')
  }
  for (const value of [
    identity.publicationRevision,
    identity.analysisFingerprint,
    identity.renderingContextFingerprint,
  ]) {
    if (!value) throw new TypeError('Presentation run identity is incomplete')
  }
}

export class PresentationRun {
  readonly runVersion = PRESENTATION_RUN_VERSION
  readonly signal: AbortSignal
  readonly startedAt: number
  readonly diagnostics: PresentationDiagnosticEvent[] = []
  state: PresentationRunState = 'idle'
  candidateCount = 0
  iterationCount = 0

  private readonly abortController: (reason?: unknown) => void
  private readonly releaseExternalSignal: () => void
  private readonly releaseDeadline: () => void
  private diagnosticSequence = 0

  constructor(
    readonly identity: PresentationRunIdentity,
    readonly budget: PresentationRunBudget = DEFAULT_PRESENTATION_RUN_BUDGET,
    externalSignal?: AbortSignal,
    private readonly now: () => number = Date.now,
  ) {
    validateIdentity(identity)
    validateBudget(budget)
    const controller = new AbortController()
    // A closure retains the native receiver even if a state library later
    // proxies the PresentationRun object.
    this.abortController = (reason?: unknown) => controller.abort(reason)
    this.signal = controller.signal
    this.startedAt = now()

    const onExternalAbort = (): void => this.cancel('external-abort')
    externalSignal?.addEventListener('abort', onExternalAbort, { once: true })
    this.releaseExternalSignal = () =>
      externalSignal?.removeEventListener('abort', onExternalAbort)
    const deadline = globalThis.setTimeout(() => {
      if (this.isTerminal || this.signal.aborted) return
      this.record('budget-maxElapsedMs')
      this.abortController(new PresentationRunBudgetError('maxElapsedMs'))
      this.releaseExternalSignal()
    }, budget.maxElapsedMs)
    this.releaseDeadline = () => {
      if (deadline !== undefined) globalThis.clearTimeout(deadline)
    }
    if (externalSignal?.aborted) this.cancel('external-abort')
  }

  get elapsedMs(): number {
    return Math.max(0, this.now() - this.startedAt)
  }

  get isTerminal(): boolean {
    return (
      this.state === 'ready' ||
      this.state === 'cancelled' ||
      this.state === 'fallback'
    )
  }

  private assertNotCancelled(): void {
    if (
      this.signal.aborted &&
      this.signal.reason instanceof PresentationRunBudgetError
    ) {
      throw this.signal.reason
    }
    if (this.signal.aborted || this.state === 'cancelled') {
      throw new PresentationRunCancelledError()
    }
  }

  assertActive(): void {
    this.assertNotCancelled()
    if (this.elapsedMs > this.budget.maxElapsedMs) {
      throw new PresentationRunBudgetError('maxElapsedMs')
    }
  }

  transition(next: PresentationRunState, code = `state-${next}`): void {
    if (next !== 'fallback') this.assertNotCancelled()
    else if (this.state === 'cancelled')
      throw new PresentationRunCancelledError()
    // A budget overrun is precisely one of the reasons to enter the safe
    // Published fallback, so that transition must remain available.
    if (next !== 'fallback') this.assertActive()
    if (!TRANSITIONS[this.state].includes(next)) {
      throw new Error(
        `Invalid presentation transition: ${this.state} -> ${next}`,
      )
    }
    this.state = next
    this.record(code)
    if (this.isTerminal) {
      this.releaseExternalSignal()
      this.releaseDeadline()
    }
  }

  consumeCandidate(): number {
    this.assertActive()
    if (this.candidateCount >= this.budget.maxCandidates) {
      throw new PresentationRunBudgetError('maxCandidates')
    }
    this.candidateCount += 1
    this.record('candidate-consumed')
    return this.candidateCount
  }

  beginIteration(): number {
    this.assertActive()
    if (this.iterationCount >= this.budget.maxIterations) {
      throw new PresentationRunBudgetError('maxIterations')
    }
    this.iterationCount += 1
    this.record('iteration-started')
    return this.iterationCount
  }

  record(code: string): void {
    if (!code) throw new TypeError('Diagnostic code cannot be empty')
    this.diagnosticSequence += 1
    this.diagnostics.push({
      sequence: this.diagnosticSequence,
      timestamp: this.now(),
      state: this.state,
      code,
    })
    while (this.diagnostics.length > this.budget.maxDiagnostics) {
      this.diagnostics.shift()
    }
  }

  cancel(reason = 'cancelled'): void {
    if (this.signal.aborted || this.isTerminal) return
    this.state = 'cancelled'
    this.record(reason)
    this.abortController(new PresentationRunCancelledError())
    this.releaseExternalSignal()
    this.releaseDeadline()
  }

  release(): void {
    this.releaseExternalSignal()
    this.releaseDeadline()
  }

  /** Reject pending third-party work even if it ignores AbortSignal itself. */
  wait<T>(operation: PromiseLike<T> | T): Promise<T> {
    this.assertActive()
    const execution = Promise.resolve(operation)
    return new Promise<T>((resolve, reject) => {
      let settled = false
      const cleanup = (): void =>
        this.signal.removeEventListener('abort', abort)
      const abort = (): void => {
        if (settled) return
        settled = true
        cleanup()
        reject(this.signal.reason ?? new PresentationRunCancelledError())
      }
      this.signal.addEventListener('abort', abort, { once: true })
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
}

export class PresentationRunCoordinator {
  private generation = 0
  private active: PresentationRun | undefined

  start(
    input: PresentationRunInput,
    options: {
      signal?: AbortSignal
      budget?: Partial<PresentationRunBudget>
      now?: () => number
    } = {},
  ): PresentationRun {
    this.active?.cancel('superseded')
    this.generation += 1
    const run = new PresentationRun(
      { ...input, generation: this.generation },
      { ...DEFAULT_PRESENTATION_RUN_BUDGET, ...options.budget },
      options.signal,
      options.now,
    )
    this.active = run
    if (!run.signal.aborted) run.transition('inspecting')
    return run
  }

  isCurrent(run: PresentationRun): boolean {
    return this.active === run && !run.signal.aborted && !run.isTerminal
  }

  owns(run: PresentationRun): boolean {
    return this.active === run
  }

  assertCurrent(run: PresentationRun): void {
    if (!this.isCurrent(run)) throw new PresentationRunCancelledError()
    run.assertActive()
  }

  /** Guard the exact synchronous point where an artifact becomes observable. */
  publish<T>(run: PresentationRun, publish: () => T): T {
    this.assertCurrent(run)
    return publish()
  }

  finish(run: PresentationRun, state: 'ready' | 'fallback'): void {
    const budgetAbort =
      run.signal.aborted &&
      run.signal.reason instanceof PresentationRunBudgetError
    if (
      this.active !== run ||
      (run.signal.aborted && !(state === 'fallback' && budgetAbort)) ||
      run.isTerminal
    ) {
      throw new PresentationRunCancelledError()
    }
    if (state === 'ready') run.assertActive()
    run.transition(state)
    run.release()
    if (this.active === run) this.active = undefined
  }

  cancelActive(reason = 'cancelled'): void {
    this.active?.cancel(reason)
    this.active = undefined
  }

  release(run: PresentationRun): void {
    run.release()
    if (this.active === run) this.active = undefined
  }
}

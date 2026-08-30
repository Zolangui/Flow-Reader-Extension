import { describe, expect, it, vi } from 'vitest'

import {
  PresentationRunBudgetError,
  PresentationRunCancelledError,
  PresentationRunCoordinator,
} from '../src/presentation-run'

const input = {
  publicationRevision: 'publication-1',
  spineIndex: 0,
  analysisFingerprint: 'analysis-1',
  renderingContextFingerprint: 'rendering-1',
}

describe('PresentationRunCoordinator', () => {
  it('supersedes generations and prevents a late run from publishing', () => {
    const coordinator = new PresentationRunCoordinator()
    const first = coordinator.start(input)
    const second = coordinator.start({ ...input, spineIndex: 1 })

    expect(first.signal.aborted).toBe(true)
    expect(first.state).toBe('cancelled')
    expect(second.identity.generation).toBe(first.identity.generation + 1)
    expect(() => coordinator.publish(first, () => 'late')).toThrow(
      PresentationRunCancelledError,
    )
    expect(coordinator.publish(second, () => 'current')).toBe('current')
  })

  it('captures external abort and releases the native controller safely', () => {
    const coordinator = new PresentationRunCoordinator()
    const controller = new AbortController()
    const run = coordinator.start(input, { signal: controller.signal })

    controller.abort()

    expect(run.signal.aborted).toBe(true)
    expect(run.state).toBe('cancelled')
    expect(() => run.assertActive()).toThrow(PresentationRunCancelledError)
  })

  it('enforces candidate, iteration, and elapsed-time budgets', () => {
    let now = 100
    const coordinator = new PresentationRunCoordinator()
    const run = coordinator.start(input, {
      budget: { maxCandidates: 1, maxIterations: 1, maxElapsedMs: 10 },
      now: () => now,
    })

    expect(run.consumeCandidate()).toBe(1)
    expect(() => run.consumeCandidate()).toThrow(PresentationRunBudgetError)
    expect(run.beginIteration()).toBe(1)
    expect(() => run.beginIteration()).toThrow(PresentationRunBudgetError)
    now = 111
    expect(() => run.assertActive()).toThrow(PresentationRunBudgetError)
    // Budget exhaustion must not block the safe Published fallback.
    coordinator.finish(run, 'fallback')
    expect(run.state).toBe('fallback')

    expect(() =>
      coordinator.start(input, { budget: { maxCandidates: 0.5 } }),
    ).toThrow(/maxCandidates/)
  })

  it('keeps diagnostics bounded and rejects invalid state transitions', () => {
    const coordinator = new PresentationRunCoordinator()
    const run = coordinator.start(input, { budget: { maxDiagnostics: 2 } })
    run.record('one')
    run.record('two')
    run.record('three')

    expect(run.diagnostics).toHaveLength(2)
    expect(run.diagnostics.map((event) => event.code)).toEqual(['two', 'three'])
    expect(() => run.transition('ready')).toThrow(
      'Invalid presentation transition',
    )
  })

  it('allows only the declared bounded validation path to become ready', () => {
    const coordinator = new PresentationRunCoordinator()
    const run = coordinator.start(input)

    run.transition('probing')
    run.transition('planning')
    run.transition('paginating')
    run.transition('validating')
    coordinator.finish(run, 'ready')

    expect(run.state).toBe('ready')
    expect(() => coordinator.publish(run, vi.fn())).toThrow(
      PresentationRunCancelledError,
    )
  })

  it('interrupts a pending promise at the real elapsed-time deadline', async () => {
    const coordinator = new PresentationRunCoordinator()
    const run = coordinator.start(input, { budget: { maxElapsedMs: 15 } })
    run.transition('probing')

    await expect(run.wait(new Promise<void>(() => undefined))).rejects.toBeInstanceOf(
      PresentationRunBudgetError,
    )
    expect(run.signal.aborted).toBe(true)
    expect(run.signal.reason).toBeInstanceOf(PresentationRunBudgetError)
    coordinator.finish(run, 'fallback')
    expect(run.state).toBe('fallback')
  })
})

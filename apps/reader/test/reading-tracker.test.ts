import { proxy } from 'valtio'
import { describe, expect, it } from 'vitest'

import type { ProgressMetricSnapshot } from '@flow/epubjs'

import type { CurrentCanonicalMetricIdentity } from '../src/db'
import {
  qualifiedCanonicalMovementUnits,
  sameCanonicalMetricIdentity,
} from '../src/hooks/useReadingTracker'
import { createUnproxiedAbortController } from '../src/models/reader'

function metric(completedUnits: number): ProgressMetricSnapshot {
  return {
    algorithmId: 'lumen-progress-metric',
    algorithmVersion: 1,
    completedUnits,
    totalUnits: 100_000,
  }
}

function identity(
  overrides: Partial<CurrentCanonicalMetricIdentity> = {},
): CurrentCanonicalMetricIdentity {
  return {
    schemaVersion: 2,
    publicationRevision: 'revision',
    canonicalModelVersion: 2,
    progressMetricAlgorithmId: 'lumen-progress-metric',
    progressMetricAlgorithmVersion: 1,
    progressMetricConfigurationFingerprint: 'weights',
    ...overrides,
  }
}

describe('reading tracker facts', () => {
  it('keeps AbortController native when stored inside a Valtio proxy', () => {
    const state = proxy({ controller: createUnproxiedAbortController() })

    expect(state.controller.signal.aborted).toBe(false)
    expect(() => state.controller.abort()).not.toThrow()
    expect(state.controller.signal.aborted).toBe(true)
  })

  it('does not count a rapid TOC-sized jump as reading', () => {
    expect(
      qualifiedCanonicalMovementUnits(metric(100), metric(80_000), 15_000),
    ).toBe(0)
    expect(
      qualifiedCanonicalMovementUnits(metric(100), metric(1900), 10_000),
    ).toBe(1800)
  })

  it('compares the progress metric identity independently from location markers', () => {
    expect(sameCanonicalMetricIdentity(identity(), identity())).toBe(true)
    expect(
      sameCanonicalMetricIdentity(
        identity(),
        identity({ progressMetricConfigurationFingerprint: 'other-weights' }),
      ),
    ).toBe(false)
  })
})

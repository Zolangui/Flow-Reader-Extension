import { webcrypto } from 'node:crypto'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import {
  admitPresentationPlan,
  createPresentationPlan,
  createValidationRecord,
  InvalidPresentationPlanError,
  PRESENTATION_PLAN_SCHEMA_VERSION,
  validatePresentationPlanInput,
  type PresentationOperationValidators,
  type PresentationPatch,
  type PresentationPlanInput,
} from '../src/presentation-plan'
import { SOURCE_TREE_MODEL_VERSION } from '../src/source-tree'

const sourceSignature = `sha256:${'a'.repeat(64)}`

function finding() {
  return {
    id: 'finding-1',
    analyzerId: 'fixture-analyzer',
    analyzerVersion: 1,
    kind: 'contrast-risk',
    confidence: 0.95,
    evidence: { foreground: '#ff66aa', background: '#111111' },
  }
}

function patch(id = 'patch-1'): PresentationPatch {
  return {
    id,
    operationVersion: 1,
    target: {
      source: {
        sourceModelVersion: SOURCE_TREE_MODEL_VERSION,
        spineIndex: 0,
        nodeKind: 'element',
        sourcePath: [0],
      },
      sourceSignature,
    },
    operation: 'remap-palette',
    parameters: { foreground: '#ff99bb' },
    reasonFindingIds: ['finding-1'],
    confidence: 0.9,
    reversible: true,
    idempotent: true,
    effects: {
      paint: true,
      geometry: 'none',
      semantics: 'none',
    },
    cost: {
      semanticLoss: 0,
      sourceScope: 1,
      geometryImpact: 0,
      changedProperties: 1,
    },
    dependencies: [],
    conflicts: [],
  }
}

function planInput(
  overrides: Partial<PresentationPlanInput> = {},
): PresentationPlanInput {
  return {
    schemaVersion: PRESENTATION_PLAN_SCHEMA_VERSION,
    engineVersion: 'lpe-test-v1',
    mode: 'published',
    publicationRevision: 'publication-1',
    analysisFingerprint: 'analysis-1',
    renderingContextFingerprint: 'rendering-1',
    findings: [],
    patches: [],
    ...overrides,
  }
}

const validators: PresentationOperationValidators = {
  'remap-palette': (parameters) => typeof parameters.foreground === 'string',
}

describe('presentation plans and validation admission', () => {
  beforeAll(() => vi.stubGlobal('crypto', webcrypto as unknown as Crypto))
  afterAll(() => vi.unstubAllGlobals())

  it('creates deterministic immutable identities for an empty Published plan', async () => {
    const first = await createPresentationPlan(planInput())
    const second = await createPresentationPlan(planInput())

    expect(first).toBeDefined()
    expect(first).toEqual(second)
    expect(first!.planHash).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(first!.paintPlanHash).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(first!.geometryPlanHash).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(Object.isFrozen(first)).toBe(true)
    expect(Object.isFrozen(first!.patches)).toBe(true)
  })

  it('hashes ordered, validated operation identities without depending on object key order', async () => {
    const firstPatch = patch('patch-a')
    const secondPatch = {
      ...patch('patch-b'),
      parameters: { background: '#111111', foreground: '#ffeeff' },
    }
    const first = await createPresentationPlan(
      planInput({
        mode: 'adaptive',
        findings: [finding()],
        patches: [firstPatch, secondPatch],
      }),
      validators,
    )
    const reorderedKeys = await createPresentationPlan(
      planInput({
        mode: 'adaptive',
        findings: [finding()],
        patches: [
          firstPatch,
          {
            ...secondPatch,
            parameters: { foreground: '#ffeeff', background: '#111111' },
          },
        ],
      }),
      validators,
    )
    const reorderedPatches = await createPresentationPlan(
      planInput({
        mode: 'adaptive',
        findings: [finding()],
        patches: [secondPatch, firstPatch],
      }),
      validators,
    )

    expect(first!.planHash).toBe(reorderedKeys!.planHash)
    expect(first!.paintPlanHash).not.toBe(reorderedPatches!.paintPlanHash)
  })

  it('rejects unvalidated operations and patches in Published mode', async () => {
    const unsafe = planInput({
      mode: 'published',
      findings: [finding()],
      patches: [patch()],
    })

    await expect(createPresentationPlan(unsafe)).rejects.toBeInstanceOf(
      InvalidPresentationPlanError,
    )
    try {
      await createPresentationPlan(unsafe)
    } catch (error) {
      const codes = (error as InvalidPresentationPlanError).issues.map(
        (issue) => issue.code,
      )
      expect(codes).toContain('published-plan-has-patches')
      expect(codes).toContain('missing-operation-validator')
    }
  })

  it('rejects dependency cycles and active conflicts deterministically', async () => {
    const first = {
      ...patch('patch-a'),
      dependencies: ['patch-b'],
      conflicts: ['patch-b'],
    }
    const second = { ...patch('patch-b'), dependencies: ['patch-a'] }

    try {
      await createPresentationPlan(
        planInput({
          mode: 'adaptive',
          findings: [finding()],
          patches: [first, second],
        }),
        validators,
      )
      throw new Error('Expected plan validation to fail')
    } catch (error) {
      const codes = (error as InvalidPresentationPlanError).issues.map(
        (issue) => issue.code,
      )
      expect(codes).toContain('dependency-cycle')
      expect(codes).toContain('active-conflict')
    }
  })

  it('admits only a passing record bound to the exact immutable plan and context', async () => {
    const plan = (await createPresentationPlan(planInput()))!
    const validation = createValidationRecord(plan, {
      validatorVersion: 1,
      passed: true,
      confidence: 1,
      probes: [
        {
          id: 'published-baseline',
          probeVersion: 1,
          passed: true,
          confidence: 1,
          metrics: {},
        },
      ],
      geometryStable: true,
      failureReasons: [],
    })
    const context = {
      engineVersion: plan.engineVersion,
      publicationRevision: plan.publicationRevision,
      analysisFingerprint: plan.analysisFingerprint,
      renderingContextFingerprint: plan.renderingContextFingerprint,
    }

    const admitted = await admitPresentationPlan(plan, validation, context)
    expect(admitted.accepted).toBe(true)

    const stale = await admitPresentationPlan(
      { ...plan, renderingContextFingerprint: 'rendering-2' },
      validation,
      context,
    )
    expect(stale).toMatchObject({ accepted: false })
    if (!stale.accepted) {
      expect(stale.reasons).toContain('stale-rendering-context')
      expect(stale.reasons).toContain('plan-integrity-failed')
    }

    const failed = await admitPresentationPlan(
      plan,
      { ...validation, passed: false },
      context,
    )
    expect(failed).toMatchObject({ accepted: false })
    if (!failed.accepted) expect(failed.reasons).toContain('validation-failed')
  })

  it('rejects malformed probe and failure records before admission', async () => {
    const plan = (await createPresentationPlan(planInput()))!

    expect(() =>
      createValidationRecord(plan, {
        validatorVersion: 1,
        passed: false,
        confidence: 0.5,
        probes: [
          {
            id: '',
            probeVersion: 0,
            passed: true,
            confidence: 2,
            metrics: {},
          },
        ],
        geometryStable: false,
        failureReasons: [{ code: '', findingIds: [''], patchIds: [] }],
      }),
    ).toThrow(/invalid-probe/)
  })

  it('reports corrupt finding and patch entries without throwing', () => {
    const corrupt = planInput({
      mode: 'adaptive',
      findings: [null] as unknown as PresentationPlanInput['findings'],
      patches: [null] as unknown as PresentationPlanInput['patches'],
    })

    expect(() => validatePresentationPlanInput(corrupt, validators)).not.toThrow()
    expect(
      validatePresentationPlanInput(corrupt, validators).map(
        (issue) => issue.code,
      ),
    ).toEqual(expect.arrayContaining(['invalid-id', 'invalid-target']))
  })

  it('returns no cacheable plan when Web Crypto is unavailable', async () => {
    vi.stubGlobal('crypto', {})
    await expect(createPresentationPlan(planInput())).resolves.toBeUndefined()
    vi.stubGlobal('crypto', webcrypto as unknown as Crypto)
  })
})

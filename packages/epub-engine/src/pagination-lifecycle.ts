import type Contents from './contents'
import type Layout from './layout'
import type IframeView from './managers/views/iframe'
import type Section from './section'

/**
 * Version of the renderer boundary around real EPUB pagination.
 *
 * Phase 2 intentionally carries no adaptive plan schema. Later presentation
 * candidates and validation records travel through the generic values without
 * changing where or when these lifecycle boundaries execute.
 */
export const PAGINATION_LIFECYCLE_VERSION = 2 as const
export const PAGINATION_ARTIFACTS_VERSION = 1 as const

export type PaginationViewPurpose = 'reader' | 'layout-measurement'

export type PaginationGeometryArtifact = {
  artifactsVersion: typeof PAGINATION_ARTIFACTS_VERSION
  producerId: string
  producerVersion: string
  spineIndex: number
  status: 'published' | 'accepted'
  /** Present only for an admitted immutable presentation plan. */
  geometryPlanHash?: string
  geometryAffecting: boolean
}

export type PaginationLifecycleArtifacts = {
  artifactsVersion: typeof PAGINATION_ARTIFACTS_VERSION
  expectedGeometryProducerIds: string[]
  geometry: PaginationGeometryArtifact[]
}

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/

function validGeometryArtifact(
  value: unknown,
): value is PaginationGeometryArtifact {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const artifact = value as PaginationGeometryArtifact
  return (
    artifact.artifactsVersion === PAGINATION_ARTIFACTS_VERSION &&
    Boolean(artifact.producerId) &&
    Boolean(artifact.producerVersion) &&
    Number.isInteger(artifact.spineIndex) &&
    artifact.spineIndex >= 0 &&
    typeof artifact.geometryAffecting === 'boolean' &&
    (artifact.status === 'published' || artifact.status === 'accepted') &&
    (artifact.status !== 'accepted' ||
      SHA256_PATTERN.test(artifact.geometryPlanHash ?? '')) &&
    (artifact.status !== 'published' ||
      artifact.geometryPlanHash === undefined) &&
    (!artifact.geometryAffecting || artifact.status === 'accepted')
  )
}

export function createPaginationLifecycleArtifacts(
  expectedGeometryProducerIds: readonly string[] = [],
): PaginationLifecycleArtifacts {
  return {
    artifactsVersion: PAGINATION_ARTIFACTS_VERSION,
    expectedGeometryProducerIds: [
      ...new Set(expectedGeometryProducerIds.filter(Boolean)),
    ].sort(),
    geometry: [],
  }
}

/** Record one producer's terminal, validated geometry decision for this view. */
export function recordPaginationGeometryArtifact(
  artifacts: PaginationLifecycleArtifacts,
  artifact: PaginationGeometryArtifact,
): void {
  if (
    artifacts.artifactsVersion !== PAGINATION_ARTIFACTS_VERSION ||
    !validGeometryArtifact(artifact)
  ) {
    throw new TypeError('Invalid pagination geometry artifact')
  }

  const index = artifacts.geometry.findIndex(
    (current) => current.producerId === artifact.producerId,
  )
  const stable = { ...artifact }
  if (index >= 0) artifacts.geometry[index] = stable
  else artifacts.geometry.push(stable)
  artifacts.geometry.sort((left, right) =>
    left.producerId < right.producerId
      ? -1
      : left.producerId > right.producerId
      ? 1
      : 0,
  )
}

export function hasCompletePaginationGeometryArtifacts(
  artifacts: PaginationLifecycleArtifacts,
): boolean {
  if (
    artifacts.artifactsVersion !== PAGINATION_ARTIFACTS_VERSION ||
    !Array.isArray(artifacts.expectedGeometryProducerIds) ||
    !Array.isArray(artifacts.geometry) ||
    artifacts.expectedGeometryProducerIds.some(
      (producerId) => typeof producerId !== 'string' || !producerId,
    ) ||
    artifacts.geometry.some((artifact) => !validGeometryArtifact(artifact))
  ) {
    return false
  }
  const expected = new Set(artifacts.expectedGeometryProducerIds)
  const completed = new Set(
    artifacts.geometry.map((artifact) => artifact.producerId),
  )
  return (
    expected.size === artifacts.expectedGeometryProducerIds.length &&
    completed.size === artifacts.geometry.length &&
    completed.size === expected.size &&
    artifacts.geometry.every((artifact) => expected.has(artifact.producerId)) &&
    artifacts.expectedGeometryProducerIds.every((producerId) =>
      completed.has(producerId),
    )
  )
}

export function acceptedGeometryPlanHashes(
  artifacts: PaginationLifecycleArtifacts,
): string[] {
  if (!hasCompletePaginationGeometryArtifacts(artifacts)) {
    throw new Error('Pagination geometry artifact set is incomplete')
  }
  return [
    ...new Set(
      artifacts.geometry
        .filter(
          (artifact) =>
            artifact.status === 'accepted' && artifact.geometryAffecting,
        )
        .map((artifact) => artifact.geometryPlanHash!),
    ),
  ]
}

export interface PaginationLifecycleContext {
  lifecycleVersion: typeof PAGINATION_LIFECYCLE_VERSION
  purpose: PaginationViewPurpose
  /** The final iframe view that will be shown or measured; never a probe DOM. */
  view: IframeView
  section: Section
  contents: Contents
  layout: Layout
  axis: string
  writingMode: string
  /** Mutable transaction record owned by this one final iframe render. */
  artifacts: PaginationLifecycleArtifacts
}

export interface PaginationLifecycle<
  Candidate = unknown,
  Validation = unknown,
> {
  /** Producers expected to reach a terminal geometry decision per view. */
  geometryProducerIds?: () => readonly string[]
  /** Stable, geometry-only pipeline configuration used by Atlas cache keys. */
  geometryPipelineFingerprint?: () => string
  /**
   * Apply every host-owned style that can affect paint or geometry to the
   * final iframe before presentation analysis and before the first pagination.
   * Reader and detached Atlas views intentionally share this boundary.
   */
  preparePagination?: (
    context: PaginationLifecycleContext,
    signal?: AbortSignal,
  ) => void | Promise<void>
  beforePagination?: (
    context: PaginationLifecycleContext,
    signal?: AbortSignal,
  ) => Candidate | Promise<Candidate>
  afterPagination?: (
    context: PaginationLifecycleContext,
    candidate: Candidate | undefined,
    signal?: AbortSignal,
  ) => Validation | Promise<Validation>
}

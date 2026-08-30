import { describe, expect, it } from 'vitest'

import {
  acceptedGeometryPlanHashes,
  createPaginationLifecycleArtifacts,
  hasCompletePaginationGeometryArtifacts,
  recordPaginationGeometryArtifact,
} from '../src/pagination-lifecycle'

const hash = `sha256:${'a'.repeat(64)}`

describe('pagination geometry artifacts', () => {
  it('accepts one valid terminal artifact per expected producer', () => {
    const artifacts = createPaginationLifecycleArtifacts(['presentation'])
    recordPaginationGeometryArtifact(artifacts, {
      artifactsVersion: 1,
      producerId: 'presentation',
      producerVersion: '1',
      spineIndex: 2,
      status: 'accepted',
      geometryPlanHash: hash,
      geometryAffecting: true,
    })

    expect(hasCompletePaginationGeometryArtifacts(artifacts)).toBe(true)
    expect(acceptedGeometryPlanHashes(artifacts)).toEqual([hash])
  })

  it('rejects duplicate terminal records even when their producer is expected', () => {
    const artifacts = createPaginationLifecycleArtifacts(['presentation'])
    const record = {
      artifactsVersion: 1 as const,
      producerId: 'presentation',
      producerVersion: '1',
      spineIndex: 2,
      status: 'published' as const,
      geometryAffecting: false,
    }
    artifacts.geometry.push(record, { ...record })

    expect(hasCompletePaginationGeometryArtifacts(artifacts)).toBe(false)
    expect(() => acceptedGeometryPlanHashes(artifacts)).toThrow(
      'Pagination geometry artifact set is incomplete',
    )
  })

  it('rejects mutated records that bypassed the recording validator', () => {
    const artifacts = createPaginationLifecycleArtifacts(['presentation'])
    artifacts.geometry.push({
      artifactsVersion: 1,
      producerId: 'presentation',
      producerVersion: '1',
      spineIndex: 2,
      status: 'accepted',
      geometryPlanHash: 'not-a-strong-hash',
      geometryAffecting: true,
    })

    expect(hasCompletePaginationGeometryArtifacts(artifacts)).toBe(false)
  })
})

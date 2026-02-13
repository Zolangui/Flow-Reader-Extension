export type ModelHealthStatus =
  | 'unknown'
  | 'downloading'
  | 'ready'
  | 'warning'
  | 'error'

export type ModelReasonCode =
  | 'none'
  | 'download_started'
  | 'download_complete'
  | 'cache_hit'
  | 'single_thread_only'
  | 'preload_timeout'
  | 'worker_bootstrap_failed'
  | 'module_export_conflict'
  | 'worker_runtime_failed'
  | 'model_load_failed'
  | 'unknown_error'

export interface ModelHealthState {
  status: ModelHealthStatus
  reasonCode: ModelReasonCode
  message?: string
  modelId?: string
  backend?: string
  progress?: number
  updatedAt: number
}

export function createModelHealthState(
  status: ModelHealthStatus,
  options?: Partial<Omit<ModelHealthState, 'status' | 'updatedAt'>>,
): ModelHealthState {
  return {
    status,
    reasonCode: options?.reasonCode ?? 'none',
    message: options?.message,
    modelId: options?.modelId,
    backend: options?.backend,
    progress: options?.progress,
    updatedAt: Date.now(),
  }
}

export function normalizeModelError(err: unknown): {
  reasonCode: ModelReasonCode
  message: string
  isFatal: boolean
} {
  const message =
    err instanceof Error ? err.message : String(err || 'unknown_error')
  const lower = message.toLowerCase()

  if (
    lower.includes('duplicate export name') ||
    lower.includes("duplicate export 'default'")
  ) {
    return { reasonCode: 'module_export_conflict', message, isFatal: true }
  }
  if (
    lower.includes('content-security-policy') ||
    lower.includes('worker-src') ||
    lower.includes('script-src') ||
    lower.includes('failed to construct') ||
    lower.includes('worker_bootstrap_failed') ||
    lower.includes('failed to asynchronously prepare wasm') ||
    lower.includes('wasm streaming compile failed') ||
    lower.includes('aborted(networkerror')
  ) {
    return { reasonCode: 'worker_bootstrap_failed', message, isFatal: true }
  }
  if (
    lower.includes('loadmodel') ||
    lower.includes('model not initialized') ||
    lower.includes('not yet called')
  ) {
    return { reasonCode: 'model_load_failed', message, isFatal: true }
  }
  if (lower.includes('timeout')) {
    return { reasonCode: 'preload_timeout', message, isFatal: false }
  }

  return { reasonCode: 'unknown_error', message, isFatal: true }
}

import { type AIProvider } from './config'

const SUPPORTED_CUSTOM_HOSTS = new Set([
  'openrouter.ai',
  'api.groq.com',
  'api.together.xyz',
  'api.mistral.ai',
  'api.deepseek.com',
])

const PROVIDER_HOSTS: Partial<Record<AIProvider, string>> = {
  openai: 'https://api.openai.com/*',
  gemini: 'https://generativelanguage.googleapis.com/*',
  anthropic: 'https://api.anthropic.com/*',
}

// These hosts are used only when the user explicitly enables downloads for
// the on-device SLM or embeddings. Keeping them optional avoids showing an AI
// service in the browser's installation prompt for a reader-only install.
export const LOCAL_MODEL_HOST_PERMISSIONS = [
  'https://huggingface.co/*',
  'https://cdn-lfs.huggingface.co/*',
  'https://hf.co/*',
]

type PermissionsApi = {
  contains?: (details: { origins: string[] }) => Promise<boolean>
  request?: (details: { origins: string[] }) => Promise<boolean>
}

export type EndpointValidation =
  | { ok: true; origin: string; permissionPattern: string }
  | {
      ok: false
      reason:
        | 'base_url_required'
        | 'invalid_base_url'
        | 'unsupported_custom_host'
    }

function getPermissionsApi(): PermissionsApi | null {
  const globalApi: any = globalThis as any
  return (
    globalApi?.browser?.permissions || globalApi?.chrome?.permissions || null
  )
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase()
  return host === 'localhost' || host === '127.0.0.1' || host === '::1'
}

/**
 * Local inference must remain local. Custom providers must use HTTPS and a
 * reviewable, explicitly declared host, so the BYOK key never travels over
 * HTTP and the extension never gains arbitrary-site access.
 */
export function validateProviderBaseUrl(
  provider: AIProvider,
  baseUrl?: string,
): EndpointValidation {
  const value = baseUrl?.trim()
  if (!value) return { ok: false, reason: 'base_url_required' }

  try {
    const url = new URL(value)
    if (url.username || url.password || url.hash) {
      return { ok: false, reason: 'invalid_base_url' }
    }

    const isLoopback = isLoopbackHost(url.hostname)
    if (provider === 'local' && !isLoopback) {
      return { ok: false, reason: 'invalid_base_url' }
    }
    if (url.protocol !== 'https:' && !(provider === 'local' && isLoopback)) {
      return { ok: false, reason: 'invalid_base_url' }
    }
    if (provider === 'custom' && !SUPPORTED_CUSTOM_HOSTS.has(url.hostname)) {
      return { ok: false, reason: 'unsupported_custom_host' }
    }

    return {
      ok: true,
      origin: url.origin,
      // Match patterns intentionally omit a port: WebExtension host permissions
      // apply to all ports for the explicitly approved host.
      permissionPattern: `${url.protocol}//${url.hostname}/*`,
    }
  } catch {
    return { ok: false, reason: 'invalid_base_url' }
  }
}

export function getProviderHostPermission(
  provider: AIProvider,
  baseUrl?: string,
): string | null {
  if (PROVIDER_HOSTS[provider]) return PROVIDER_HOSTS[provider] || null
  const endpoint = validateProviderBaseUrl(provider, baseUrl)
  return endpoint.ok ? endpoint.permissionPattern : null
}

export async function hasProviderHostPermission(
  provider: AIProvider,
  baseUrl?: string,
): Promise<boolean> {
  const origin = getProviderHostPermission(provider, baseUrl)
  if (!origin) return false
  const permissions = getPermissionsApi()
  // Allows the reader app to run in its normal web development environment.
  if (!permissions?.contains) return true
  try {
    return await permissions.contains({ origins: [origin] })
  } catch {
    return false
  }
}

/** Must be called directly from a user gesture so browsers can show consent. */
export function requestProviderHostPermission(
  provider: AIProvider,
  baseUrl?: string,
): Promise<boolean> {
  const origin = getProviderHostPermission(provider, baseUrl)
  if (!origin) return Promise.resolve(false)
  const permissions = getPermissionsApi()
  if (!permissions?.request) return Promise.resolve(true)
  try {
    return permissions.request({ origins: [origin] })
  } catch {
    return Promise.resolve(false)
  }
}

/**
 * Request every origin used by the immutable local-model download URLs.
 * Call this directly from a user gesture; checking first would risk losing
 * the browser's user-gesture requirement for a permission prompt.
 */
export function requestLocalModelHostPermissions(): Promise<boolean> {
  const permissions = getPermissionsApi()
  if (!permissions?.request) return Promise.resolve(true)
  try {
    return permissions.request({ origins: LOCAL_MODEL_HOST_PERMISSIONS })
  } catch {
    return Promise.resolve(false)
  }
}

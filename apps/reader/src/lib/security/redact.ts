const REDACTED = '[REDACTED]'

const SECRET_KEY_NAME_REGEX =
  /(api[-_ ]?key|authorization|x-api-key|x-goog-api-key|token|secret|password)/i

const SECRET_VALUE_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{10,}\b/g, // OpenAI-like keys
  /\bAIza[0-9A-Za-z\-_]{20,}\b/g, // Google-style keys
  /\bBearer\s+[A-Za-z0-9._-]{10,}\b/gi, // Bearer tokens
  /\b(x-api-key|x-goog-api-key|authorization)\s*[:=]\s*[^,\s]+/gi,
]

function redactString(input: string): string {
  return SECRET_VALUE_PATTERNS.reduce(
    (acc, pattern) => acc.replace(pattern, REDACTED),
    input,
  )
}

function sanitizeAny(
  value: unknown,
  seen: WeakSet<object>,
  depth: number,
): unknown {
  if (value == null) return value
  if (depth > 6) return value

  if (typeof value === 'string') {
    return redactString(value)
  }

  if (typeof value !== 'object') return value

  const obj = value as Record<string, unknown>
  if (seen.has(obj)) return '[Circular]'
  seen.add(obj)

  if (Array.isArray(obj)) {
    return obj.map((item) => sanitizeAny(item, seen, depth + 1))
  }

  const out: Record<string, unknown> = {}
  for (const [key, val] of Object.entries(obj)) {
    if (SECRET_KEY_NAME_REGEX.test(key)) {
      out[key] = REDACTED
      continue
    }
    out[key] = sanitizeAny(val, seen, depth + 1)
  }
  return out
}

export function sanitizeForLogs<T = unknown>(value: T): T {
  try {
    const seen = new WeakSet<object>()
    return sanitizeAny(value, seen, 0) as T
  } catch {
    return value
  }
}

export function sanitizeErrorForLogs(error: unknown): {
  name?: string
  message?: string
  status?: number | string
  code?: string
} {
  try {
    const err = error as any
    return sanitizeForLogs({
      name: err?.name,
      message: String(err?.message || err || ''),
      status: err?.status ?? err?.response?.status,
      code: err?.code,
    })
  } catch {
    return { message: 'Unknown error' }
  }
}

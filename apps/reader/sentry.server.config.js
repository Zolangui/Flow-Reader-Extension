// This file configures the initialization of Sentry on the server.
// The config you add here will be used whenever the server handles a request.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/

import * as Sentry from '@sentry/nextjs'

const SENTRY_DSN = process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN

const REDACTED = '[REDACTED]'
const SECRET_KEY_NAME_REGEX =
  /(api[-_ ]?key|authorization|x-api-key|x-goog-api-key|token|secret|password)/i
const SECRET_VALUE_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{10,}\b/g,
  /\bAIza[0-9A-Za-z\-_]{20,}\b/g,
  /\bBearer\s+[A-Za-z0-9._-]{10,}\b/gi,
  /\b(x-api-key|x-goog-api-key|authorization)\s*[:=]\s*[^,\s]+/gi,
]

function scrubString(input) {
  return SECRET_VALUE_PATTERNS.reduce(
    (acc, pattern) => acc.replace(pattern, REDACTED),
    String(input || ''),
  )
}

function scrubObjectInPlace(value, seen = new WeakSet(), depth = 0) {
  if (!value || typeof value !== 'object' || depth > 6) return
  if (seen.has(value)) return
  seen.add(value)

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      if (typeof value[i] === 'string') {
        value[i] = scrubString(value[i])
      } else {
        scrubObjectInPlace(value[i], seen, depth + 1)
      }
    }
    return
  }

  for (const key of Object.keys(value)) {
    const raw = value[key]
    if (SECRET_KEY_NAME_REGEX.test(key)) {
      value[key] = REDACTED
      continue
    }
    if (typeof raw === 'string') {
      value[key] = scrubString(raw)
    } else {
      scrubObjectInPlace(raw, seen, depth + 1)
    }
  }
}

Sentry.init({
  dsn:
    SENTRY_DSN ||
    'https://911830b959464866b3820e27379f4d38@o955619.ingest.sentry.io/6537954',
  sendDefaultPii: false,
  // Adjust this value in production, or use tracesSampler for greater control
  tracesSampleRate: 1.0,
  beforeBreadcrumb(breadcrumb) {
    try {
      scrubObjectInPlace(breadcrumb)
    } catch {
      // noop
    }
    return breadcrumb
  },
  beforeSend(event) {
    try {
      scrubObjectInPlace(event)
    } catch {
      // noop
    }
    return event
  },
  // ...
  // Note: if you want to override the automatic release value, do not set a
  // `release` value here - use the environment variable `SENTRY_RELEASE`, so
  // that it will also get attached to your source maps
})

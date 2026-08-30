/** Normalize untrusted public analyzer options without weakening work bounds. */
export function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isFinite(value)) return fallback
  return Math.max(minimum, Math.min(maximum, Math.floor(value!)))
}

/** Normalize a finite scalar constrained to an inclusive interval. */
export function boundedNumber(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isFinite(value)) return fallback
  return Math.max(minimum, Math.min(maximum, value!))
}

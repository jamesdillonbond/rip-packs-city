export function normalizeParallel(parallel?: string | null) {
  const value = (parallel ?? "").trim()
  return value.length > 0 ? value : null
}

export function buildMarketScopeKey(
  editionKey?: string | null,
  parallel?: string | null
) {
  const normalizedEditionKey = (editionKey ?? "").trim() || "none"
  const normalizedParallel = normalizeParallel(parallel) ?? "base"
  return `${normalizedEditionKey}::${normalizedParallel}`
}
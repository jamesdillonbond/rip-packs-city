export function normalizeSetName(setName?: string | null) {
  if (!setName) return ""
  if (setName === "Base Set6") return "Base Set"
  return setName
}

export function normalizeParallel(parallel?: string | null) {
  const value = (parallel ?? "").trim()
  return value.length ? value : "Base"
}

export function normalizeSeries(series?: string | number | null) {
  if (series === null || series === undefined) return ""
  return String(series).trim()
}

export function buildEditionScopeKey(input: {
  editionKey?: string | null
  setName?: string | null
  playerName?: string | null
  parallel?: string | null
  subedition?: string | null
}) {
  const editionKey =
    (input.editionKey ?? "").trim() ||
    `${normalizeSetName(input.setName)}-${input.playerName ?? "unknown"}`

  const parallel = normalizeParallel(input.parallel ?? input.subedition ?? "")
  return `${editionKey}::${parallel}`
}
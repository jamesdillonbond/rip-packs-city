// Series display-label → server `series` query param resolver. Extracted from
// app/(collections)/[collection]/collection/page.tsx, where this exact block
// was DUPLICATED verbatim in two request builders (fetchPaginatedMoments +
// autoPaginate) — a drift hazard. One tested implementation removes it.
//
// Resolution order (byte-identical to the inline copies): first the dynamic
// per-collection options (label → seriesNumber), then a Top Shot hardcoded
// label→number fallback, else null (caller leaves the param unset).

const TOPSHOT_SERIES_LABEL_TO_NUM: Record<string, string> = {
  "Series 1": "0",
  "Series 2": "2",
  "Summer 2021": "3",
  "Series 3": "4",
  "Series 4": "5",
  "Series 2023-24": "6",
  "Series 2024-25": "7",
  "Series 2025-26": "8",
}

export function resolveSeriesParam(
  label: string,
  options: Array<{ label: string; seriesNumber: number }>
): string | null {
  const match = options.find((s) => s.label === label)
  if (match) return String(match.seriesNumber)
  return TOPSHOT_SERIES_LABEL_TO_NUM[label] ?? null
}

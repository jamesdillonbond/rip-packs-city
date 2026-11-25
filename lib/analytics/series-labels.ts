// Canonical Top Shot series labels mapped from on-chain UInt32 series IDs.
//
// On-chain series=1 doesn't exist in Top Shot's data — series=0 IS Series 1.
// Editions tagged with series=1 in our catalog are an unmapped/anomalous
// artifact (mostly UUID-based imports that didn't carry a real series tag);
// they render as "Misc / Unmapped" with a tooltip explaining the anomaly.
//
// NFL All Day decodes through its contract's own series names (2026-11-24:
// on-chain 9 is "2025 Season", even numbers are Historical releases) — see
// ALLDAY_SERIES_DISPLAY in lib/series-label.ts. Other collections (Golazos /
// UFC) carry their own series numbers — an unknown integer falls back to
// "Series N". A null series resolves to "Misc / Unmapped".

import { ALLDAY_SERIES_DISPLAY } from "@/lib/series-label"

const TOPSHOT_SERIES: Record<number, string> = {
  0: "Series 1",
  2: "Series 2",
  3: "Summer 2021",
  4: "Series 3",
  5: "Series 4",
  6: "Series 2023-24",
  7: "Series 2024-25",
  8: "Series 2025-26",
  9: "Series 2026-27",
}

export const TOPSHOT_SERIES_ORDER: number[] = [0, 2, 3, 4, 5, 6, 7, 8, 9]

export function topshotSeriesLabel(series: number | null | undefined): string {
  if (series == null) return "Misc / Unmapped"
  if (series === 1) return "Misc / Unmapped"
  return TOPSHOT_SERIES[series] ?? `Series ${series}`
}

export function seriesLabel(
  collection: string | null | undefined,
  series: number | null | undefined
): string {
  const c = (collection || "").toLowerCase()
  if (c === "topshot") return topshotSeriesLabel(series)
  if (series == null) return "Misc / Unmapped"
  if (c === "allday" || c === "nfl_all_day" || c === "nfl-all-day") return ALLDAY_SERIES_DISPLAY[series] ?? `Series ${series}`
  return `Series ${series}`
}

export function isUnmappedSeriesLabel(label: string): boolean {
  return label === "Misc / Unmapped"
}

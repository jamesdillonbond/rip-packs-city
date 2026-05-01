// Canonical Top Shot series labels mapped from on-chain UInt32 series IDs.
//
// On-chain series=1 doesn't exist in Top Shot's data — series=0 IS Series 1.
// Editions tagged with series=1 in our catalog are an unmapped/anomalous
// artifact (mostly UUID-based imports that didn't carry a real series tag);
// they render as "Misc / Unmapped" with a tooltip explaining the anomaly.
//
// Other collections (AllDay / Golazos / UFC) typically carry their own
// series numbers — when we receive an unknown integer we fall back to
// "Series N". A null series resolves to "Misc / Unmapped".

const TOPSHOT_SERIES: Record<number, string> = {
  0: "Series 1",
  2: "Series 2",
  3: "Summer 2021",
  4: "Series 3",
  5: "Series 4",
  6: "Series 2023-24",
  7: "Series 2024-25",
  8: "Series 2025-26",
}

export const TOPSHOT_SERIES_ORDER: number[] = [0, 2, 3, 4, 5, 6, 7, 8]

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
  return `Series ${series}`
}

export function isUnmappedSeriesLabel(label: string): boolean {
  return label === "Misc / Unmapped"
}

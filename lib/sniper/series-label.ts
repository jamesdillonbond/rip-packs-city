// lib/sniper/series-label.ts
//
// One series label per Top Shot sniper deal (2026-10-25). The GQL listing path mapped the
// on-chain series number through the sniper's short labels ("25-26", "S4"), while the two
// RPC-backed paths passed `series_name` through as stored — a bare "8", "0" or "Series 8" — so
// 1,000 of 1,016 cards read "NBA Cup · 7" and "0" (Series 1 on Top Shot) read as a series.
// Unknown shapes pass through unchanged; a label is never invented.

export const TOPSHOT_SERIES_LABELS: Record<number, string> = {
  0: "S1", 2: "S2", 3: "Sum 21", 4: "S3", 5: "S4", 6: "23-24", 7: "24-25", 8: "25-26", 9: "26-27",
}

export function topShotSeriesLabel(raw: string | null | undefined): string {
  const s = String(raw ?? "").trim()
  const m = /^(?:series\s*)?(\d+)$/i.exec(s)
  if (!m) return s
  return TOPSHOT_SERIES_LABELS[Number(m[1])] ?? s
}

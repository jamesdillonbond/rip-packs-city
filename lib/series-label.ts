// Top Shot series encoders. Top Shot stores series as a raw on-chain UInt32
// where 0 = Series 1 (there is NO on-chain series 1 — see the CLAUDE.md series
// map), so a naive `Series ${n}` mislabels every edition. Both the analytics
// board and the moment page decode this via the SAME canonical map below, so
// their labels agree (they previously disagreed on the season labels — analytics
// showed "2023-24" while the moment page showed "Series 2023-24"; unified
// 2026-07-27 onto the internally-consistent "Series 2023-24" form).
//
// The two exported helpers differ only in their FALLBACK for an unmapped series,
// which is a legitimate context difference (not an inconsistency):
//   seriesLabel   — collection-agnostic analytics board; unmapped → "Unknown"
//   seriesDisplay — moment page, Top Shot only; unmapped/non-TS → "Series N"

/** Canonical on-chain-series → display label. Note 0 = "Series 1" (no on-chain 1). */
export const SERIES_DISPLAY: Record<number, string> = {
  0: "Series 1",
  2: "Series 2",
  3: "Summer 2021",
  4: "Series 3",
  5: "Series 4",
  6: "Series 2023-24",
  7: "Series 2024-25",
  8: "Series 2025-26",
}

/** Analytics-board series label (collection-agnostic). Unmapped/nullish → "Unknown". */
export function seriesLabel(n: number | null | undefined): string {
  if (n === null || n === undefined) return "Unknown"
  return SERIES_DISPLAY[n] ?? "Unknown"
}

/**
 * Moment-page series display. Top Shot decodes via SERIES_DISPLAY (unmapped n →
 * "Series N"); every other collection's series encoding is unverified, so it
 * falls back to the raw "Series N".
 */
export function seriesDisplay(n: number, collectionSlug: string | null | undefined): string {
  const isTopShot = collectionSlug === "nba_top_shot" || collectionSlug === "nba-top-shot"
  if (isTopShot) return SERIES_DISPLAY[n] ?? `Series ${n}`
  return `Series ${n}`
}

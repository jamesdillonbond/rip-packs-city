// Top Shot series encoders. Top Shot stores series as a raw on-chain UInt32
// where 0 = Series 1 (there is NO on-chain series 1 — see the CLAUDE.md series
// map), so a naive `Series ${n}` mislabels every edition. Both the analytics
// board and the moment page decode this, and they are extracted here verbatim so
// the load-bearing mapping is unit-tested.
//
// ⚠️ KNOWN INCONSISTENCY (documented, deliberately NOT unified here — a product
// decision, not a refactor): the two encoders disagree on the SEASON labels.
//   seriesLabel(6)   → "2023-24"          (analytics; collection-agnostic; unknown → "Unknown")
//   seriesDisplay(6) → "Series 2023-24"   (moment; Top Shot only; non-TS/unknown → "Series N")
// So series 6 renders "2023-24" on the analytics board and "Series 2023-24" on
// the moment page. Preserved as-is; unify at the UI layer if desired.

/** Analytics-board series label (collection-agnostic). Unknown/other → "Unknown". */
export function seriesLabel(n: number | null | undefined): string {
  if (n === null || n === undefined) return "Unknown"
  switch (n) {
    case 0: return "Series 1"
    case 2: return "Series 2"
    case 3: return "Summer 2021"
    case 4: return "Series 3"
    case 5: return "Series 4"
    case 6: return "2023-24"
    case 7: return "2024-25"
    case 8: return "2025-26"
    default: return "Unknown"
  }
}

// Moment-page series display map (Top Shot only). Note the "Series " prefix on
// the season labels, which seriesLabel above omits.
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

/**
 * Moment-page series display. Top Shot decodes via SERIES_DISPLAY (unknown n →
 * "Series N"); every other collection's series encoding is unverified, so it
 * falls back to the raw "Series N".
 */
export function seriesDisplay(n: number, collectionSlug: string | null | undefined): string {
  const isTopShot = collectionSlug === "nba_top_shot" || collectionSlug === "nba-top-shot"
  if (isTopShot) return SERIES_DISPLAY[n] ?? `Series ${n}`
  return `Series ${n}`
}

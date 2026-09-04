// Pure view-shaping for the public /share/[wallet] collection card
// (app/share/[wallet]/page.tsx) — a heavily-shared, un-gated surface measured by
// NEITHER coverage gate. Extracted verbatim so the two bits of real logic are
// tested: the series-breakdown bar scaling (sorted labels + a safe max so a bar
// never divides by zero) and the closed-market disclosure sentence (singular vs
// plural), which is an HONESTY line — closed-market moments are counted but
// excluded from Total FMV, and the copy must say so correctly.

export const NO_SERIES_LABEL = "No series"

export function buildSeriesBars(
  seriesBreakdown: Record<string, number>,
): { entries: Array<[string, number]>; max: number } {
  // get_wallet_collection_snapshot labels a null series_number 'S' || 'Unknown';
  // the card rendered that literally ("1414 SUnknown" on the founder's wallet,
  // 2026-09-04). Name it and sort it after the real series.
  const entries = Object.entries(seriesBreakdown)
    .map(([k, v]): [string, number] => [k === "SUnknown" || k === "Snull" ? NO_SERIES_LABEL : k, v])
    .sort(([a], [b]) =>
      a === NO_SERIES_LABEL ? 1 : b === NO_SERIES_LABEL ? -1 : a.localeCompare(b, undefined, { numeric: true }),
    )
  const max = Math.max(...entries.map(([, v]) => v), 1)
  return { entries, max }
}

export interface ShareCollectionRow {
  name: string
  market_closed_at?: string | null
}

/** The disclosure sentence for any collections whose market is closed, or null
 *  when none are — closed-market moments count toward the moment total but are
 *  excluded from Total FMV, and the singular/plural must match. */
export function closedMarketNote(perCollection: ShareCollectionRow[] | null | undefined): string | null {
  const closed = (perCollection ?? []).filter((c) => c.market_closed_at)
  if (closed.length === 0) return null
  const names = closed.map((c) => c.name).join(", ")
  return `${names} ${closed.length === 1 ? "market is" : "markets are"} closed — ${closed.length === 1 ? "its" : "their"} moments are counted but excluded from Total FMV.`
}

// Pure view-shaping for the public /share/[wallet] collection card
// (app/share/[wallet]/page.tsx) — a heavily-shared, un-gated surface measured by
// NEITHER coverage gate. Extracted verbatim so the two bits of real logic are
// tested: the series-breakdown bar scaling (sorted labels + a safe max so a bar
// never divides by zero) and the closed-market disclosure sentence (singular vs
// plural), which is an HONESTY line — closed-market moments are counted but
// excluded from Total FMV, and the copy must say so correctly.

import { DB_SLUG_TO_SLUG, getCollection } from "@/lib/collections"
export const NO_SERIES_LABEL = "No series"

/**
 * The share card's headline, on the same rule as the dashboard and the public
 * profile since 2026-09-02: LIVE FMV = total − stale, with the stale share named
 * in a caption. Before 2026-09-04 the front door headlined the raw total, so a
 * collector who pasted a username ($98K) and then signed up ($47K + $52K stale)
 * watched their number halve at the activation moment.
 *
 * Absent stale fields (an older API shape) mean "no split known" — the raw total
 * is shown with NO caption, never a fabricated zero-stale claim.
 */
export interface ShareHeadline {
  live: number
  stale: number
  staleCount: number
  caption: string | null
}
export function shareHeadline(input: {
  totalFmv: number | null | undefined
  staleFmv?: number | null
  staleCount?: number | null
}): ShareHeadline {
  const total = Number(input.totalFmv) || 0
  const staleKnown = input.staleFmv != null && Number.isFinite(Number(input.staleFmv))
  const stale = staleKnown ? Math.max(0, Number(input.staleFmv)) : 0
  const staleCount = Math.max(0, Number(input.staleCount) || 0)
  const live = Math.max(0, total - stale)
  const caption =
    staleKnown && stale > 0
      ? `+ $${stale.toLocaleString("en-US", { maximumFractionDigits: 0 })} across ${staleCount.toLocaleString("en-US")} stale-priced moment${staleCount === 1 ? "" : "s"}`
      : null
  return { live, stale, staleCount, caption }
}

/** One bar of the snapshot's ordered `seriesBars` array (2026-09-24). */
export interface SeriesBar {
  label: string
  count: number
  series_number: number | null
}

/**
 * The bars, from the RPC's ORDERED array when it carries one (one
 * collection's series, named the way every page names them — "Series 1",
 * "Summer 2021", "Series 2025-26" — in on-chain order, which no lexical sort
 * of the labels reproduces), else from the legacy `{label: count}` object.
 * The null-series bucket is named and stays last either way.
 */
export function buildSeriesBarsFrom(
  seriesBars: SeriesBar[] | null | undefined,
  seriesBreakdown: Record<string, number> | null | undefined,
): { entries: Array<[string, number]>; max: number } {
  if (Array.isArray(seriesBars) && seriesBars.length > 0) {
    const entries = seriesBars.map((b): [string, number] => [
      b.label === "SUnknown" || b.label === "Snull" || b.series_number == null ? NO_SERIES_LABEL : b.label,
      Number(b.count) || 0,
    ])
    const max = Math.max(...entries.map(([, v]) => v), 1)
    return { entries, max }
  }
  return buildSeriesBars(seriesBreakdown ?? {})
}

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

// Resolve the tab a "View Full Collection" click should land on, from the
// wallet's OWN holdings rather than a hardcoded collection. 2026-09-19: this
// link was `/nba-top-shot/collection?wallet=<addr>` for every wallet, so a Candy
// MLB holder was sent to the Top Shot tab to look at a collection they do not
// have. `perCollection[].slug` is the DB slug (`candy_mlb`), so it goes through
// DB_SLUG_TO_SLUG to reach the route segment.
//
// ⚠ Not every collection HAS a `collection` tab, and linking to one that does
// not exist would trade one wrong destination for a 404. So the tab is chosen
// from the registry's own `pages`, and `overview` is the fallback, never a
// guess. ⚠ THE EXAMPLE IN THIS COMMENT USED TO BE CANDY ("overview + market
// only") and it went stale within hours — Candy gained its Collection tab on
// 2026-09-19. The live example is Panini (`overview` + `sniper`), and the
// registry read is what made that turnover a no-op here. Do not re-hardcode a
// collection's tab list into this file.
export function fullCollectionHref(
  perCollection: Array<{ slug: string; moments: number }> | undefined,
  wallet: string,
): string {
  const enc = encodeURIComponent(wallet)
  const dominant = (perCollection ?? [])
    .slice()
    .sort((a, b) => (b.moments ?? 0) - (a.moments ?? 0))[0]
  const urlSlug = dominant ? DB_SLUG_TO_SLUG[dominant.slug] : undefined
  if (!urlSlug) return `/nba-top-shot/collection?wallet=${enc}`
  const coll = getCollection(urlSlug)
  if (coll?.pages.includes("collection")) return `/${urlSlug}/collection?wallet=${enc}`
  return `/${urlSlug}/overview`
}

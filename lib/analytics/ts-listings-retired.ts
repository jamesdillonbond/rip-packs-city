// ─────────────────────────────────────────────────────────────────────────────
// The Top Shot orderbook sampler is RETIRED. Single source of truth for that
// fact and for the copy that discloses it.
//
// WHY THIS FILE EXISTS (deep-audit D12 → D12b). `ts_listings` was switched off
// with the Top Shot listings-indexer on 2026-05-26. It holds exactly ONE row,
// written 2026-05-15. `analytics_listings_summary` still computes a
// `topshot_orderbook` block from it, so every count/median/p90 derived from that
// block is a percentile over a single row that is now ~99 days old.
//
// D12 was closed on `components/analytics/ListingsDashboard.tsx` alone. The same
// block was still being rendered by the per-collection analytics tab
// (`OrderBookCard`), which published "ORDER BOOK DEPTH · 1 listings · MEDIAN ASK
// $5.0k" to anonymous visitors for three more months. That is the documented
// "fix per PANEL, not per page" failure, and it is why the strings live here
// instead of being copy-pasted a third time.
//
// ⚠ DO NOT "FIX" THIS BY NULLING THE `topshot_orderbook` LEG OF THE RPC. The
// consumer branches `count === 0 → "No live listings."`, so a server-side null
// would publish "No live listings" for a collection that carries thousands of
// live `low_ask` rows in `edition_offers`. Both branches would then be false.
// Only the rendering surface can tell the truth, which is why the disclosure is
// a component concern.
// ─────────────────────────────────────────────────────────────────────────────

/** The day the `ts_listings` sampler was switched off. */
export const TS_LISTINGS_RETIRED_ON = "2026-05-26"

/** The day the last (and only surviving) `ts_listings` row was written. */
export const TS_LISTINGS_LAST_ROW_ON = "2026-05-15"

/**
 * Collections whose orderbook block comes from a retired source.
 *
 * ⚠ Keyed on the SHORT collection string (`topshot`, `allday`, …), which is the
 * vocabulary the analytics surfaces use. Non-members read `marketplace_listings`,
 * a live source, and must keep rendering their real numbers.
 */
const RETIRED_ORDERBOOK_SHORTS = new Set(["topshot"])

/** True when this collection's orderbook depth would come from a retired feed. */
export function hasRetiredOrderbookSource(short: string): boolean {
  return RETIRED_ORDERBOOK_SHORTS.has((short || "").toLowerCase())
}

/** Short label for the retired state. */
export const TS_ORDERBOOK_RETIRED_LABEL = "This feed is retired."

/**
 * The disclosure itself. States what was switched off, when, and what the reader
 * should use instead.
 *
 * ⚠ It reports rather than concludes, and it never implies an absence of live
 * Top Shot asks — there are plenty, they just are not in this table.
 */
export const TS_ORDERBOOK_RETIRED_BODY =
  `The Top Shot orderbook sampler was switched off on ${TS_LISTINGS_RETIRED_ON} and its last row was ` +
  `written on ${TS_LISTINGS_LAST_ROW_ON}, so no depth is shown here rather than a figure derived from ` +
  `a single stale row. Live Top Shot ask data is on the Sniper deal feed.`

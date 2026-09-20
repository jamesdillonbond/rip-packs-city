// ─────────────────────────────────────────────────────────────────────────────
// Top Shot order-book PROVENANCE. Single source of truth for whether the
// `topshot_orderbook` block may be rendered as depth, and for the copy that
// discloses it when it may not.
//
// ── WHAT THIS REPLACED, AND WHY IT HAD TO BE REPLACED ───────────────────────
// This file was `ts-listings-retired.ts`. `ts_listings` really was switched off
// on 2026-05-26 (one row, written 2026-05-15), and deep-audit D12 → D12b built
// a disclosure so the per-collection analytics tab would stop publishing
// "ORDER BOOK DEPTH · 1 listings · MEDIAN ASK $5.0k" to anonymous visitors.
//
// On 2026-09-07 `ts_listings` was rewired to the Atlas firehose and is now
// rebuilt every ~2 minutes. Measured 2026-09-20 09:25 PT: 60,350 rows across
// 2,377 editions, oldest row 2026-09-19, median ask $1.00, p90 $14.00. The
// disclosure was never revisited, so for ~13 days the public tab suppressed a
// real 60k-row order book in order to tell readers the feed's last row was
// written on 2026-05-15. That is the #80 mirror: an `unknown` that is actually
// KNOWN, which is the same defect class as a failed read rendered as a fact.
//
// ── WHY THE DATE CONSTANTS ARE GONE ─────────────────────────────────────────
// `TS_LISTINGS_RETIRED_ON` / `TS_LISTINGS_LAST_ROW_ON` were the failure mode,
// not the fix. A hardcoded date cannot notice that its own premise expired, and
// the ratchet that guards this module is explicit that it asserts the
// disclosure is REFERENCED, never that the sentence is TRUE — so it stayed
// green across the whole 13 days. Shipping a corrected date would have re-armed
// the identical trap pointing the other way, because the feed can go dark
// again. The block now publishes its own `age_hours`, and this module decides
// from that. Remove the failure mode; do not soften the detector.
//
// ── WHY THE AGE IS A PROP AND NOT A CLOCK READ ──────────────────────────────
// `age_hours` is computed server-side in `analytics_listings_summary`. Reading
// a clock during render is the React #418 hydration defect — the first render
// must be anchored to a prop.
//
// ⚠ DO NOT "FIX" A STALE FEED BY NULLING THE `topshot_orderbook` LEG OF THE RPC.
// The consumer branches `count === 0 → "No live listings."`, so a server-side
// null would publish "No live listings" for a collection that carries thousands
// of live `low_ask` rows in `edition_offers`. Both branches would then be false.
// Only the rendering surface can tell the truth, which is why this is a
// component concern.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How old the newest row in the book may be before depth stops being published
 * as current. Matches the 6 h freshness gate the edition-page "% Listed"
 * feature already uses, so the site speaks with one definition of "fresh".
 *
 * The lane that feeds this refreshes every ~2 minutes, so 6 h is roughly 180
 * missed ticks — comfortably past "a slow morning" and safely short of a day.
 */
export const TS_ORDERBOOK_STALE_AFTER_HOURS = 6

/**
 * THREE STATES, never two.
 *
 * - `fresh`   — the book was rebuilt within the window; render the real depth.
 * - `stale`   — we know the age and it is past the window; disclose the age.
 * - `unknown` — we have no age at all (the block is empty, or the read failed
 *               before it could carry one). Never rendered as depth and never
 *               rendered as staleness, because we did not learn either.
 */
export type TsOrderbookProvenance = "fresh" | "stale" | "unknown"

/**
 * Classify the block from the age it published.
 *
 * ⚠ `null`/`undefined` is `unknown`, NOT fresh and NOT zero. The RPC emits a
 * NULL age when the filtered set is empty precisely so an absent measurement
 * cannot be read as a recent one.
 */
export function classifyTsOrderbook(ageHours: number | null | undefined): TsOrderbookProvenance {
  if (ageHours == null || !Number.isFinite(ageHours)) return "unknown"
  return ageHours <= TS_ORDERBOOK_STALE_AFTER_HOURS ? "fresh" : "stale"
}

/** Short label for a book we know to be behind. */
export const TS_ORDERBOOK_STALE_LABEL = "This feed is behind."

/** Short label for a book whose age we never learned. */
export const TS_ORDERBOOK_UNKNOWN_LABEL = "Order book unavailable."

/**
 * Render an age in the coarsest unit that is still honest, so the disclosure
 * reads as a measurement rather than a rounded guess.
 */
function describeAge(ageHours: number): string {
  if (ageHours < 1) return `${Math.max(1, Math.round(ageHours * 60))} minutes`
  if (ageHours < 48) return `${Math.round(ageHours)} hours`
  return `${Math.round(ageHours / 24)} days`
}

/**
 * The staleness disclosure. Reports the measured age and points at the live
 * alternative; it never concludes that Top Shot has no asks, because it does.
 *
 * ⚠ ONE template literal, NOT `+`-joined template literals whose interpolations
 * are all compile-time constants. MEASURED 2026-08-22 on this module's
 * predecessor: the bundler folded such a chain and the PRODUCTION BUNDLE
 * dropped the tail of the first segment, so the page rendered
 * "...switched off on 2026-05-26written on 2026-05-15...". The committed source
 * was correct, so no source-level test could see it. `ageHours` here is a
 * runtime value, which is what keeps this one unfoldable — do not "simplify" it
 * back into constants.
 */
export function tsOrderbookStaleBody(ageHours: number): string {
  return `The Top Shot order book has not been rebuilt for ${describeAge(ageHours)}, so its depth is not shown rather than published as current. Live Top Shot ask data is on the Sniper deal feed.`
}

/**
 * The unknown-age disclosure. Distinct from the stale copy on purpose: not
 * knowing the age is a different fact from knowing it is old, and collapsing
 * the two is how a failed read gets published as a measurement.
 */
export const TS_ORDERBOOK_UNKNOWN_BODY =
  "We could not confirm when the Top Shot order book was last rebuilt, so its depth is not shown. Live Top Shot ask data is on the Sniper deal feed."

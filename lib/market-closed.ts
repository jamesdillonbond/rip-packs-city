// lib/market-closed.ts
//
// Which collections no longer have a live market on the chain we index, and the
// date that market closed.
//
// WHY THIS EXISTS
//   FMV is a *lagging* statistic. When a marketplace shuts down, the FMV pipeline
//   keeps carrying the last computed value forward: `computed_at` refreshes, so
//   every freshness signal on the site reads "recent", while the underlying
//   evidence is frozen at the day trading stopped. The result is that we render a
//   dead price with the same styling, the same "Value $X" page title, and the same
//   schema.org Offer as a genuinely live one.
//
//   Measured live 2026-08-02 for UFC Strike:
//     * ZERO sales in the last 30 days -- by collection_id, by collection text,
//       and in unmapped_sales. The last Flow UFC sale of any kind was 2026-05-13.
//     * 149 of 518 editions carry a price. Their median snapshot age is 62 days.
//     * `days_since_sale` on those priced editions averages 1,458 for the 98
//       SALES_ONLY editions (~4 years) and 470-524 for the MEDIUM/HIGH ones --
//       yet 15 of them were RE-STAMPED with a computed_at of today, so the
//       freshness pill reads green on evidence that is over a year old.
//
//   So a per-row "is this snapshot old?" heuristic is not enough: the snapshot
//   timestamp itself lies. The honest signal is the collection-level fact that the
//   market is closed, which is static, verifiable, and dated. That is what this
//   module encodes.
//
// WHY A STATIC MAP AND NOT A DB LOOKUP
//   `v_collection_marketplace_status` already carries a `shutdown` status for UFC
//   and backs the MarketplaceStatusBanner, but reading it is async and cached, and
//   the surfaces that most need this fact are pure/synchronous: `lib/seo.ts` builds
//   titles, descriptions and JSON-LD with no DB access at all. Market closure is a
//   dated historical event, not live state, so a static map is the correct shape --
//   the same call `lib/collection-tiers.ts` makes for per-collection tier vocab.
//   The DB view stays the source of truth for the *banner*; this is the source of
//   truth for "may we publish this number as a current price?".
//
// WHEN A MARKET REOPENS OR CLOSES, EDIT THIS MAP -- not the individual pages.

/** A market we no longer index live trading for. */
export interface ClosedMarket {
  /** ISO date (YYYY-MM-DD) of the last observed sale on the chain we index. */
  closedOn: string
  /** Short human phrase for the venue that closed, used in UI copy. */
  venue: string
  /** One sentence a user can read and act on. No jargon. */
  note: string
}

/**
 * Keyed by URL slug. Both the canonical slug and any accepted alias must be
 * present -- `getCollectionByUrlSlug` resolves "ufc-strike" as well as "ufc", so
 * alias URLs render real pages and would otherwise skip the disclosure entirely.
 */
export const CLOSED_MARKETS: Record<string, ClosedMarket> = {
  ufc: {
    closedOn: "2026-05-13",
    venue: "Flow",
    note:
      "UFC Strike's Flow marketplace is closed - the last Flow sale was on 13 May 2026. " +
      "Prices below are the last values we observed before it closed, kept for reference. " +
      "They are historical, not current, and nothing here can be bought or sold on Flow.",
  },
}
CLOSED_MARKETS["ufc-strike"] = CLOSED_MARKETS["ufc"]

/** True when the collection's market is closed and prices must not read as current. */
export function isMarketClosed(collectionUrlSlug: string | null | undefined): boolean {
  if (!collectionUrlSlug) return false
  // Own-key check only: `slug in CLOSED_MARKETS` would match inherited
  // Object.prototype keys ('toString', 'constructor', …), falsely flagging them
  // as closed markets.
  return Object.prototype.hasOwnProperty.call(CLOSED_MARKETS, collectionUrlSlug)
}

/** The closure record, or null for a live market. */
export function closedMarket(collectionUrlSlug: string | null | undefined): ClosedMarket | null {
  if (!collectionUrlSlug) return null
  // Own-key guard first: a bare `CLOSED_MARKETS[slug]` returns the inherited
  // Object.prototype member for 'toString'/'constructor'/…, which is truthy and
  // would leak a bogus non-record instead of null.
  if (!Object.prototype.hasOwnProperty.call(CLOSED_MARKETS, collectionUrlSlug)) return null
  return CLOSED_MARKETS[collectionUrlSlug] ?? null
}

/**
 * "13 May 2026" - stable, locale-independent formatting for a closure date.
 * Built from the ISO parts so it is a pure function of the input string and
 * cannot differ between the server render and the client hydration.
 */
export function formatClosedOn(iso: string): string {
  const MONTHS = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ]
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (!m) return iso
  const [, y, mo, d] = m
  const monthName = MONTHS[Number(mo) - 1]
  if (!monthName) return iso
  return `${Number(d)} ${monthName} ${y}`
}

/**
 * Short inline marker for a price rendered on a closed market, e.g.
 * "as of 13 May 2026". Returns null for live markets so callers can skip it.
 */
export function closedPriceAsOf(collectionUrlSlug: string | null | undefined): string | null {
  const cm = closedMarket(collectionUrlSlug)
  return cm ? `as of ${formatClosedOn(cm.closedOn)}` : null
}

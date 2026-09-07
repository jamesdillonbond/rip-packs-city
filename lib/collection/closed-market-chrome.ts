// lib/collection/closed-market-chrome.ts
//
// Collection-chrome copy that makes a claim about the MARKET, and what it
// becomes once that market has closed.
//
// WHY THIS EXISTS
//   Three surfaces on every tab of a collection assert, in the SERVER-RENDERED
//   HTML, that trading is happening right now:
//     · the ticker's red pill, which literally reads "LIVE";
//     · the ticker items ("COLLECTION ANALYZER — FMV + active listing prices",
//       "SNIPER — fight moments below market");
//     · the overview's Tools grid ("Real-time deals below FMV",
//       "FMV · Flowty asks · badge intel").
//   Measured on production /ufc/overview 2026-09-06: all four render, on a
//   collection whose Flow market last traded 13 May 2026.
//
//   ⚠ This is the SECOND round on the same defect. The /ufc/sniper header was
//   fixed hours earlier the same evening, and these are four more panels of the
//   identical claim on a page that fix did not touch — which is the CLAUDE.md
//   rule "fix per PANEL, not per page" arriving exactly as advertised.
//
//   ⚠ And none of it is covered by MarketplaceStatusBanner, which resolves
//   client-side: the shell a reader or crawler gets first carries these with
//   nothing beside them, and a failed banner fetch never corrects them.
//
// ⭐ DERIVED FROM closedMarket(). No per-slug branch anywhere below — a market
//   that closes next is covered by editing CLOSED_MARKETS alone, which is what
//   lib/market-closed.ts's own header asks for.
//
// ⚠ THE COPY AVOIDS THE WORD "live" ENTIRELY, even in a negation. The guard on
//   this is a blunt token ban; a ban that has to reason about "not" is a ban
//   that will eventually be wrong.

import { closedMarket, formatClosedOn } from "@/lib/market-closed"

export const TICKER_STATUS_LIVE = "LIVE"
export const TICKER_STATUS_CLOSED = "CLOSED"

/**
 * The ticker's leading pill. "LIVE" is a claim, not a decoration — it sits in
 * brand red at the top of every tab.
 */
export function tickerStatusLabel(collectionUrlSlug: string): string {
  return closedMarket(collectionUrlSlug) ? TICKER_STATUS_CLOSED : TICKER_STATUS_LIVE
}

/**
 * Ticker items. A closed market replaces the whole list rather than editing
 * individual entries: the live lists are per-collection feature blurbs written
 * for a trading venue, and the honest version of that list is a different list,
 * not the same one with a disclaimer bolted on.
 */
export function tickerItems(collectionUrlSlug: string, liveItems: readonly string[]): string[] {
  const cm = closedMarket(collectionUrlSlug)
  if (!cm) return [...liveItems]
  const on = formatClosedOn(cm.closedOn).toUpperCase()
  const venue = cm.venue.toUpperCase()
  return [
    `⚡ ${venue} MARKET CLOSED ${on} — EVERY PRICE BELOW IS A FINAL ONE`,
    "⚡ COLLECTION ANALYZER — YOUR MOMENTS AT THEIR CLOSING VALUES",
    "⚡ SALES HISTORY — EVERY RECORDED SALE, THROUGH THE LAST ONE",
    "⚡ ANALYTICS — PORTFOLIO BREAKDOWN AT CLOSING PRICES",
  ]
}

/**
 * The overview Tools grid. Keyed by the tab's page id.
 *
 * ⚠ THE CLOSED MAP IS THE SUPPRESSION LIST, NOT THE RULE. The rule is the guard
 * in __tests__/closed-market-chrome-makes-no-trading-claim.test.ts: for every
 * closed market × every page in TOOL_CARD_DESC, the resulting string must carry
 * no liveness token. Pages absent from CLOSED_TOOL_CARD_DESC fall through to
 * their live copy — which is correct for the ones that make no market claim
 * ("Completion + bottleneck finder") and is CAUGHT BY THE GUARD for any that do.
 * So a new tool card with a trading claim reds the suite instead of shipping.
 */
export const TOOL_CARD_DESC: Record<string, string> = {
  collection: "FMV · Flowty asks · badge intel",
  packs: "Expected value vs price",
  sniper: "Real-time deals below FMV",
  sets: "Completion + bottleneck finder",
  analytics: "Portfolio breakdown + clarity",
  market: "Edition lookup + leaderboards",
}

/** Pinnacle prices from its own listing feed, not Flowty. Pre-existing override. */
const PINNACLE_TOOL_CARD_DESC: Record<string, string> = {
  collection: "FMV · listing prices · deal finder",
}

const CLOSED_TOOL_CARD_DESC: Record<string, string> = {
  collection: "Your moments at their closing values",
  packs: "Expected value against final prices",
  sniper: "The last discounts before the market closed",
  market: "Edition lookup + closing leaderboards",
}

function own<T>(map: Record<string, T>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined
}

/**
 * Description for one Tools-grid card.
 *
 * Order is deliberate: a closed market wins over the Pinnacle override, because
 * "listing prices" is as much a trading claim as "Flowty asks" is.
 */
export function toolCardDesc(page: string, collectionUrlSlug: string): string {
  if (closedMarket(collectionUrlSlug)) {
    const closed = own(CLOSED_TOOL_CARD_DESC, page)
    if (closed) return closed
  } else if (collectionUrlSlug === "disney-pinnacle") {
    const pinnacle = own(PINNACLE_TOOL_CARD_DESC, page)
    if (pinnacle) return pinnacle
  }
  return own(TOOL_CARD_DESC, page) ?? ""
}

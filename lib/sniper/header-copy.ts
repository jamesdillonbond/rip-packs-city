// lib/sniper/header-copy.ts
//
// The Sniper page's header subtitle.
//
// WHY THIS IS ITS OWN MODULE
//   The subtitle used to be a ternary inlined in SniperClient.tsx reading
//   "LIVE DEALS BELOW ADJUSTED FMV — BADGE-AWARE, SERIAL-ADJUSTED". That is a
//   claim about the MARKET, and on 2026-09-06 it was found in the
//   SERVER-RENDERED HTML of production /ufc/sniper — a collection whose Flow
//   market last traded 13 May 2026 (lib/market-closed.ts).
//
//   ⚠ The MarketplaceStatusBanner further down that page is NOT a fix for it.
//   The banner resolves its status client-side, so the shell a reader (and a
//   crawler) receives first carries the false line with nothing beside it, and
//   if that fetch fails nothing corrects it at all. The disclosure has to live
//   in synchronously-rendered copy — which is precisely the reason
//   lib/market-closed.ts is a static map rather than a DB read.
//
//   Pulled out of the component so the property can be pinned by a plain unit
//   test instead of by mounting a very large client component in jsdom.
//
// ⭐ DERIVED FROM closedMarket(), never a per-slug branch. A market that closes
//   next is covered by editing CLOSED_MARKETS alone, which is what that
//   module's own header asks for.

import { closedMarket, formatClosedOn } from "@/lib/market-closed"

export const SNIPER_SUBTITLE_DEFAULT =
  "LIVE DEALS BELOW ADJUSTED FMV — BADGE-AWARE, SERIAL-ADJUSTED"

export const SNIPER_SUBTITLE_PINNACLE = "LIVE PINNACLE DEALS BELOW FMV — VARIANT-AWARE"

/**
 * Subtitle for the Sniper header.
 *
 * A closed market wins over every other variant: there is no such thing as a
 * "live Pinnacle deal" on a venue that has stopped trading either, so the
 * closure branch is checked first rather than folded in beside \`isPinnacle\`.
 *
 * ⚠ The copy deliberately avoids the WORD "live" even in a negation ("…NOT LIVE
 * DEALS" was the first draft). The guard on this is a blunt token ban, and a
 * ban that has to reason about negation is a ban that will eventually be wrong;
 * a label scanned at a glance is also better off without the word at all.
 */
export function sniperSubtitle(collectionUrlSlug: string, isPinnacle: boolean): string {
  const cm = closedMarket(collectionUrlSlug)
  if (cm) {
    return (
      `${cm.venue.toUpperCase()} MARKET CLOSED ${formatClosedOn(cm.closedOn).toUpperCase()}` +
      ` — FINAL OBSERVED DISCOUNTS, NOTHING IS TRADING`
    )
  }
  return isPinnacle ? SNIPER_SUBTITLE_PINNACLE : SNIPER_SUBTITLE_DEFAULT
}

// lib/concierge/edition-listings.ts
//
// Backs the concierge's `get_edition_listings` tool: "what's the cheapest one
// listed right now, and where do I buy it?" for ONE named edition.
//
// Why this exists. Before it, every listing-shaped tool the concierge had was a
// DEAL tool — search_live_deals and search_catalog_deals both require a
// discount (`.gt("discount", 0)`), and the sniper feed is a discount-ranked
// board, not an order book. So an edition that is listed at or above FMV, or
// simply not on today's board, was indistinguishable from an edition nobody has
// listed. Asked for a specific Lillard Archive Set moment, the bot answered
// "it's not showing a current listing in the live feed — meaning nothing may be
// listed right now, or it's priced above the feed's current snapshot", which is
// the assistant narrating our own index instead of answering the question.
//
// ⚠ THE HONESTY RULE THIS MODULE EXISTS TO ENFORCE. There are three outcomes,
// not two, and collapsing any pair of them produces a false market claim:
//   listed      — we asked, there are asks, here is the cheapest
//   none_listed — we asked, the order book is empty (a real answer about the market)
//   unavailable — we could not ask (a statement about US, never about the market)
// `unavailable` is the one that keeps getting flattened into `none_listed`,
// because a failed fetch and an empty book both arrive as "no rows". The whole
// point of `listingsStatus` is that the caller cannot skip that distinction.

/** Live-ask lookup outcome for one edition. See the module header. */
export type ListingsStatus = "listed" | "none_listed" | "unavailable"

/**
 * Resolve the three-way status from a floor lookup.
 *
 * `ok` answers "did we reach the marketplace", NOT "were there rows" — it is
 * the same flag /api/edition-floor now carries, and it must be derived from the
 * transport, never from the row count. Passing `ok: count > 0` would reduce
 * this back to the two-outcome bug it exists to prevent.
 */
export function listingsStatus(
  ok: boolean,
  count: number,
  floor: number | null,
): ListingsStatus {
  if (!ok) return "unavailable"
  // A floor with no count (or vice versa) still means the book is non-empty —
  // upstream populates `forSaleCount` and `lowestAsk` independently, and a
  // missing one of the pair is not evidence of an empty book.
  if ((count != null && count > 0) || (floor != null && floor > 0)) return "listed"
  return "none_listed"
}

/**
 * The one sentence the model is allowed to say about availability, derived from
 * the status so the wording can never drift from the measurement. Returned in
 * the tool result rather than left to the model, because "nothing is listed" is
 * a market claim and this is the only place that knows whether we earned it.
 */
export function listingsNote(status: ListingsStatus, marketplace: string): string {
  switch (status) {
    case "listed":
      return `floor_ask is the lowest live ask on ${marketplace} at fetched_at. It moves; treat it as a snapshot, not a quote.`
    case "none_listed":
      return `${marketplace} answered and there are NO live asks for this edition right now. This is a real answer about the market — say it plainly.`
    case "unavailable":
      return `We could NOT reach ${marketplace} to check listings. You must say the live check failed — do NOT say nothing is listed, and do NOT present fmv as a listing price. Point the user at edition_url for the live floor.`
  }
}

/** Percent below FMV, or null when either side is missing/non-positive. */
export function discountPct(ask: number | null, fmv: number | null): number | null {
  if (ask == null || fmv == null) return null
  if (!(fmv > 0) || !(ask > 0)) return null
  return Math.round(((fmv - ask) / fmv) * 1000) / 10
}

/**
 * RPC's own edition page — the durable link, and the correct fallback whenever
 * the live check fails, since that page renders the floor itself.
 *
 * ⚠ The key is encoded: Top Shot keys are `setID:playID` and a raw colon in a
 * path segment is what produced the half-escaped URLs in earlier bot replies.
 */
export function editionPageUrl(collectionSlug: string, editionKey: string): string {
  return `/${collectionSlug}/edition/${encodeURIComponent(editionKey)}`
}

/** Absolute form of {@link editionPageUrl} for chat surfaces (Telegram/Discord). */
export function absoluteEditionPageUrl(
  base: string,
  collectionSlug: string,
  editionKey: string,
): string {
  return `${base.replace(/\/+$/, "")}${editionPageUrl(collectionSlug, editionKey)}`
}

// ⚠ THERE IS DELIBERATELY NO EDITION-LEVEL MARKETPLACE LINK HERE.
//
// The repo links to Top Shot at MOMENT grain only — `marketplaceMomentUrl`
// builds `nbatopshot.com/moment/<flowId>`, and that is the only Top Shot URL
// shape anywhere in the codebase that has ever been verified against the live
// site. A plausible-looking edition/listings permalink was drafted here and
// removed: nothing in the repo, and nothing reachable from this sandbox (which
// is proxy-blocked to nbatopshot.com), could confirm the path.
//
// A dead link in a concierge answer is worse than no link — the user has
// already been told "go here to buy it" by the time it 404s. So the tool hands
// out `edition_url` (RPC's own edition page, which renders the live floor and
// the listing depth) plus per-serial `buy_url`s built from the verified
// moment-grain template. If an edition permalink is ever confirmed, add it
// here and it flows into the tool result unchanged.

/** A special serial that is currently listed for this edition. */
export interface SpecialSerialListing {
  serial: number
  is_first_mint: boolean
  is_perfect_mint: boolean
  ask: number | null
  serial_fmv: number | null
  discount_pct: number | null
  buy_url: string | null
}

/**
 * Label the chase serials among an edition's live listings.
 *
 * ⚠ `is_perfect_mint` is the claim that makes a moment worth many multiples of
 * floor, so a false positive here is a false valuation. The predicate uses
 * STRICT equality deliberately: with `==`, a null circulation against a null
 * serial would report a perfect mint out of two missing values.
 *
 * ⚠ The two explicit null guards in that predicate are UNREACHABLE today and
 * are kept as belt-and-braces, not because a test covers them — mutation
 * confirms removing them changes nothing, and a fixture that exercised them
 * would be asserting a state the function cannot be handed. `circulation` is
 * already excluded by `===` (`50 === null` is false), and `serial_number` is
 * already excluded by the `.filter` above. They become load-bearing the moment
 * that filter is relaxed or the comparison is loosened to `==`, which is
 * exactly when someone would otherwise delete them.
 */
export function markSpecialSerials(
  rows: Array<{
    serial_number: number | null
    ask_usd: number | string | null
    serial_fmv_usd: number | string | null
    nft_id: string | null
  }>,
  circulation: number | null,
  buyUrl: (nftId: string | null) => string | null,
): SpecialSerialListing[] {
  const num = (v: number | string | null): number | null =>
    v == null ? null : Number.isFinite(Number(v)) ? Number(v) : null

  return rows
    .filter((r) => r.serial_number != null)
    .map((r) => {
      const ask = num(r.ask_usd)
      const sfmv = num(r.serial_fmv_usd)
      return {
        serial: r.serial_number as number,
        is_first_mint: r.serial_number === 1,
        is_perfect_mint:
          circulation != null && r.serial_number != null && r.serial_number === circulation,
        ask,
        serial_fmv: sfmv,
        discount_pct: discountPct(ask, sfmv),
        buy_url: buyUrl(r.nft_id),
      }
    })
    .sort((a, b) => {
      // Chase serials first (they are the reason to call this at all), then
      // cheapest — so a truncated list never drops the #1 for a cheaper common.
      const chase = (s: SpecialSerialListing) => (s.is_first_mint || s.is_perfect_mint ? 1 : 0)
      return chase(b) - chase(a) || (a.ask ?? Infinity) - (b.ask ?? Infinity)
    })
}

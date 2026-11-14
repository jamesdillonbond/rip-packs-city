// lib/market/open-offer-flags.ts
//
// Flags for one of a wallet's OPEN offers (feedback #12361, "my open offers").
// Shared by /api/wallet-offers?view=open and its tests.
//
//   outbid            ANOTHER wallet has a strictly higher open offer on the same target.
//   superseded        the SAME wallet has a strictly higher open offer there — and nobody else
//                     beats it. Outbid wins: another wallet beating you is the fact that matters.
//   stale             the offer has stood BID_STALE_DAYS (14) or more — the offer-spread board's threshold.
//   at_or_above_floor the edition floor is KNOWN and at or under the offer. A null floor is unknown,
//                     never 0, so it never sets this flag.
import { isBidStale } from "@/lib/market/bid-age"

export type OpenOfferFlags = { outbid: boolean; superseded: boolean; stale: boolean; at_or_above_floor: boolean }

/** Flags for one row. Outbid wins over superseded: another wallet beating you is the fact that matters. */
export function classifyOpenOffer(
  r: { amount_usd: number | null; top_other_bid: number | null; own_higher_usd: number | null; floor_usd: number | null; created_at: string | null },
  now: number = Date.now(),
): OpenOfferFlags {
  const amt = r.amount_usd
  const outbid = amt != null && r.top_other_bid != null && r.top_other_bid > amt
  const superseded = !outbid && amt != null && r.own_higher_usd != null && r.own_higher_usd > amt
  const stale = isBidStale(r.created_at, now)
  const at_or_above_floor = amt != null && r.floor_usd != null && amt >= r.floor_usd
  return { outbid, superseded, stale, at_or_above_floor }
}


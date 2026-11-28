// lib/market/open-offer-flags.ts
//
// Flags for one of a wallet's OPEN offers (feedback #12361, "my open offers").
// Shared by /api/wallet-offers?view=open and its tests.
//
//   outbid            ANOTHER wallet has a strictly higher open offer on the same target.
//   superseded        the SAME wallet has a strictly higher open offer there — and nobody else
//                     beats it. Outbid wins: another wallet beating you is the fact that matters.
//   stale             the offer has stood BID_STALE_DAYS (14) or more — the offer-spread board's threshold.
//   at_or_above_floor you could buy THE THING YOU BID ON for no more than your offer:
//                     - edition / parallel offer: the edition floor is KNOWN and at or under the offer;
//                     - serial offer: THAT exact Moment was seen listed at or under the offer.
//                     ⚠ Never the edition floor for a serial offer — the floor is the cheapest copy of
//                     the edition, a DIFFERENT serial (2026-11-14: one wallet had 274 of its newest 500
//                     offers flagged this way, every one a ~$1 serial bid against a ~$0.69 floor).
//                     A null floor / unseen listing is unknown, never 0, so it never sets this flag.
//   above_value       (2026-11-27) an EDITION or PARALLEL offer more than ABOVE_VALUE_RATIO (20 %) over
//                     RPC's FMV for what it bids on. ⚠ NEVER a serial offer: a serial bid targets one
//                     exact serial (often a low or special one) and edition FMV is the wrong yardstick —
//                     on 2026-11-27, 1,607 of 2,663 saved-wallet serial offers sat above edition FMV, almost
//                     all deliberate. A null FMV is unknown, never 0, so it never sets this flag.
import { isBidStale } from "@/lib/market/bid-age"

export type OpenOfferFlags = { outbid: boolean; superseded: boolean; stale: boolean; at_or_above_floor: boolean; above_value: boolean }

/** An edition / parallel offer above FMV × this ratio is flagged "above RPC value". */
export const ABOVE_VALUE_RATIO = 1.2

/** Flags for one row. Outbid wins over superseded: another wallet beating you is the fact that matters. */
export function classifyOpenOffer(
  r: {
    offer_type?: string | null
    amount_usd: number | null
    top_other_bid: number | null
    own_higher_usd: number | null
    floor_usd: number | null
    serial_ask_usd?: number | null
    created_at: string | null
    /** RPC FMV of the edition / parallel the offer bids on; null = unknown. */
    fmv_usd?: number | null
  },
  now: number = Date.now(),
): OpenOfferFlags {
  const amt = r.amount_usd
  const outbid = amt != null && r.top_other_bid != null && r.top_other_bid > amt
  const superseded = !outbid && amt != null && r.own_higher_usd != null && r.own_higher_usd > amt
  const stale = isBidStale(r.created_at, now)
  const buyNow = r.offer_type === "serial" ? r.serial_ask_usd ?? null : r.floor_usd
  const at_or_above_floor = amt != null && buyNow != null && amt >= buyNow
  const fmv = r.fmv_usd ?? null
  const above_value = r.offer_type !== "serial" && amt != null && fmv != null && fmv > 0 && amt > fmv * ABOVE_VALUE_RATIO
  return { outbid, superseded, stale, at_or_above_floor, above_value }
}


// lib/marketplace-fees.ts
//
// Published seller-side marketplace fees, and the deal math that follows from
// them.
//
// ── Why this exists ────────────────────────────────────────────────────────
// Every price on every RPC surface is GROSS. A board that says "35% below FMV"
// is quietly assuming you can resell at FMV and keep all of it — you cannot. The
// operator takes its cut out of the seller's proceeds, so the number that
// actually decides whether a listing is worth buying is what you NET on the way
// back out. Neither the native marketplaces nor Dapper Market surface that, and
// it costs nothing to compute because the rates are published.
//
// It also exposes a fact nobody surfaces: the rates are NOT the same across the
// three collections on the deals board. Disney Pinnacle charges 7.5% — half
// again what Top Shot and All Day charge — plus a $0.50 listing fee that acts as
// a floor. On a $1 pin (the board's actual minimum ask) that floor is a 50%
// haircut, and calling such a listing a "deal" on gross discount alone is wrong.
//
// ── Sources (fetched and quoted 2026-07-26) ────────────────────────────────
// NBA Top Shot — support.nbatopshot.com "Marketplace Fees":
//   "For each sale made on the Marketplace and the All-Star VIP Marketplace, a
//   5% fee is applied." Worked example: a $10.00 listing pays the seller $9.50.
// NFL ALL DAY — support.nflallday.com "Marketplace Fees":
//   "For each sale made on the NFL ALL DAY Marketplace, a 5% fee is applied."
//   Worked example: a $10.00 listing pays the seller $9.50.
// UFC Strike — support.ufcstrike.com "Marketplace Fees":
//   "For each sale made on the UFC Strike marketplace, a 5% fee is applied…the
//   seller will receive $9.50", and explicitly "There is no fee for listing and
//   delisting a Moment on the Marketplace." (UFC's Flow market has been dead
//   since 2026-05-13, so this is recorded for completeness.)
// LaLiga Golazos — support.laligagolazos.com "Marketplace Net Spend":
//   "For each sale made on the Marketplace, there is a 5% fee applied. So when a
//   Moment that is listed for $100 is sold, the seller will receive $95."
// Disney Pinnacle — disneypinnacle.com "Marketplace 101":
//   "The Marketplace Fee is currently reduced to 7.5% until further notice",
//   "deducted from your earnings upon a successful sale"; plus a "$0.50 fee that
//   must be paid to create a listing", which "is deducted from the marketplace
//   fee when your listing sells successfully" and is NOT refunded on a cancelled
//   or expired listing.
//
// Two consequences of Pinnacle's structure, both modelled below:
//   1. Because the $0.50 is credited against the marketplace fee on a successful
//      sale, the total cost of a completed sale is max(7.5% x price, $0.50) —
//      the listing fee is a FLOOR, not an addition.
//   2. Pinnacle's rate is explicitly temporary ("until further notice"), so it
//      carries a `provisional` flag. Re-verify it before treating it as fixed.
//
// Candy MLB (Magic Eden / Solana) and Panini have NO verified entry: they return
// null and their callers show nothing. Guessing a rate would put a fabricated
// number on a money surface, which is the exact class of defect this codebase
// keeps finding — and Magic Eden's taker/royalty split is not the same shape as
// a flat Dapper seller fee anyway, so it needs its own model, not a copied one.
import { ownLookup } from "@/lib/safe-lookup"

export interface MarketplaceFee {
  /** `collections.slug` — the vocabulary the deals board emits. */
  collectionSlug: string
  label: string
  /** Seller fee as a fraction of sale price. */
  pct: number
  /**
   * Effective floor on the total fee for a COMPLETED sale, in USD. Non-zero
   * only where a non-refundable listing fee is credited against the sale fee.
   */
  minFeeUsd: number
  sourceUrl: string
  /** ISO date the rate above was last read from the source. */
  verifiedOn: string
  /** True when the operator publishes the rate as temporary. */
  provisional?: boolean
  note?: string
}

const FEES: MarketplaceFee[] = [
  {
    collectionSlug: "nba_top_shot",
    label: "NBA Top Shot",
    pct: 0.05,
    minFeeUsd: 0,
    sourceUrl: "https://support.nbatopshot.com/hc/en-us/articles/1500003409882-Marketplace-Fees",
    verifiedOn: "2026-07-26",
  },
  {
    collectionSlug: "nfl_all_day",
    label: "NFL ALL DAY",
    pct: 0.05,
    minFeeUsd: 0,
    sourceUrl: "https://support.nflallday.com/hc/en-us/articles/4424218588819-Marketplace-Fees",
    verifiedOn: "2026-07-26",
  },
  {
    collectionSlug: "laliga_golazos",
    label: "LaLiga Golazos",
    pct: 0.05,
    minFeeUsd: 0,
    sourceUrl: "https://support.laligagolazos.com/hc/en-us/articles/11010979030931-Marketplace-Net-Spend",
    verifiedOn: "2026-07-26",
  },
  {
    collectionSlug: "ufc_strike",
    label: "UFC Strike",
    pct: 0.05,
    minFeeUsd: 0,
    sourceUrl: "https://support.ufcstrike.com/hc/en-us/articles/15880103782029-Marketplace-Fees",
    verifiedOn: "2026-07-26",
    note: "Rate recorded for completeness — UFC's Flow secondary market has been dead since 2026-05-13.",
  },
  {
    collectionSlug: "disney_pinnacle",
    label: "Disney Pinnacle",
    pct: 0.075,
    minFeeUsd: 0.5,
    sourceUrl: "https://disneypinnacle.com/news/marketplace-101",
    verifiedOn: "2026-07-26",
    provisional: true,
    note: "Rate is published as reduced 'until further notice'. The $0.50 listing fee is credited against the marketplace fee on a successful sale, so it acts as a floor — and it is not refunded if the listing expires or is cancelled.",
  },
]

const BY_SLUG = new Map(FEES.map((f) => [f.collectionSlug, f]))

/** Alternate slugs seen on RPC surfaces, mapped to the canonical fee key. */
const SLUG_ALIASES: Record<string, string> = {
  topshot: "nba_top_shot",
  "nba-top-shot": "nba_top_shot",
  allday: "nfl_all_day",
  "nfl-all-day": "nfl_all_day",
  pinnacle: "disney_pinnacle",
  "disney-pinnacle": "disney_pinnacle",
  golazos: "laliga_golazos",
  "laliga-golazos": "laliga_golazos",
  ufc: "ufc_strike",
  "ufc-strike": "ufc_strike",
}

/** The published fee for a collection, or null when we have not verified one. */
export function sellerFeeFor(collectionSlug: string | null | undefined): MarketplaceFee | null {
  if (!collectionSlug) return null
  const key = collectionSlug.trim().toLowerCase()
  return BY_SLUG.get(key) ?? BY_SLUG.get(ownLookup(SLUG_ALIASES, key) ?? "") ?? null
}

export function allMarketplaceFees(): MarketplaceFee[] {
  return FEES.slice()
}

/** Fee charged on a completed sale at `price`, honouring the listing-fee floor. */
export function feeOnSale(price: number, fee: MarketplaceFee): number {
  if (!Number.isFinite(price) || price <= 0) return 0
  return Math.max(price * fee.pct, fee.minFeeUsd)
}

/** What the seller actually receives at `price`. Never negative. */
export function netProceeds(price: number, fee: MarketplaceFee): number {
  if (!Number.isFinite(price) || price <= 0) return 0
  return Math.max(0, price - feeOnSale(price, fee))
}

export interface FeeNetDeal {
  /** What you'd keep reselling at FMV, after the operator's cut. */
  netIfResold: number
  /** netIfResold − ask. NEGATIVE when the gross "discount" does not survive fees. */
  netMarginUsd: number
  /** netMarginUsd as a percentage of the money you put in (the ask). */
  netMarginPct: number
  /** The gross headline for comparison: (fmv − ask) / fmv. */
  grossDiscountPct: number
  /** True when the listing looks like a deal gross but is not one net. */
  flipsNegative: boolean
  fee: MarketplaceFee
}

/**
 * The honest version of a deals-board row.
 *
 * Deliberately expressed as return on the ASK rather than as a discount off
 * FMV: the ask is the money actually at risk, and quoting the margin against
 * FMV would flatter it in exactly the same way the gross discount already does.
 *
 * Returns null — never a zero or a guess — when the ask or FMV is missing or
 * non-positive, or when the collection has no verified published rate.
 */
export function feeNetDeal(
  ask: number | null | undefined,
  fmv: number | null | undefined,
  collectionSlug: string | null | undefined,
): FeeNetDeal | null {
  const a = ask == null ? NaN : Number(ask)
  const f = fmv == null ? NaN : Number(fmv)
  if (!Number.isFinite(a) || a <= 0) return null
  if (!Number.isFinite(f) || f <= 0) return null
  const fee = sellerFeeFor(collectionSlug)
  if (!fee) return null

  const netIfResold = netProceeds(f, fee)
  const netMarginUsd = netIfResold - a
  return {
    netIfResold: Math.round(netIfResold * 100) / 100,
    netMarginUsd: Math.round(netMarginUsd * 100) / 100,
    netMarginPct: Math.round((netMarginUsd / a) * 1000) / 10,
    grossDiscountPct: Math.round(((f - a) / f) * 1000) / 10,
    flipsNegative: f > a && netMarginUsd <= 0,
    fee,
  }
}

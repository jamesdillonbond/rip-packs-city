// lib/insights/offer-spread-collections.ts
//
// The Bid vs Floor board's collections, views and tier vocabularies (All Day joined 2026-10-26, Top Shot parity).
// PURE — no imports — because the client component reads it too, and lib/insights/offer-spread-board.ts imports the
// service-role Supabase client, which must never reach a browser bundle.

export const OFFER_SPREAD_VIEWS = {
  "nba-top-shot": "topshot_offer_ask_spread",
  "nfl-all-day": "allday_offer_ask_spread",
} as const
export type OfferSpreadCollection = keyof typeof OFFER_SPREAD_VIEWS

export function isOfferSpreadCollection(v: string | null | undefined): v is OfferSpreadCollection {
  return v === "nba-top-shot" || v === "nfl-all-day"
}

/** Tier vocabularies differ: All Day has UNCOMMON and no FANDOM. */
export const OFFER_SPREAD_TIERS: Record<OfferSpreadCollection, readonly string[]> = {
  "nba-top-shot": ["COMMON", "FANDOM", "RARE", "LEGENDARY", "ULTIMATE"],
  "nfl-all-day": ["COMMON", "UNCOMMON", "RARE", "LEGENDARY", "ULTIMATE"],
}

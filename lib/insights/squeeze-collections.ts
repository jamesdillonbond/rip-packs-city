// lib/insights/squeeze-collections.ts
//
// The Lock-Rate Squeeze Board's collections (NFL All Day joined 2026-10-27, Top Shot parity pass 6) and their tier
// vocabularies. PURE — no imports — because the client component reads it too, and lib/insights/squeeze-board.ts
// imports the service-role Supabase client, which must never reach a browser bundle.

export const SQUEEZE_COLLECTIONS = ["nba-top-shot", "nfl-all-day"] as const
export type SqueezeCollection = (typeof SQUEEZE_COLLECTIONS)[number]

export function isSqueezeCollection(v: string | null | undefined): v is SqueezeCollection {
  return v === "nba-top-shot" || v === "nfl-all-day"
}

export const SQUEEZE_LABEL: Record<SqueezeCollection, string> = {
  "nba-top-shot": "Top Shot",
  "nfl-all-day": "NFL All Day",
}

/** Tier vocabularies differ: All Day has UNCOMMON and no FANDOM. */
export const SQUEEZE_TIERS: Record<SqueezeCollection, readonly string[]> = {
  "nba-top-shot": ["COMMON", "RARE", "LEGENDARY", "FANDOM", "ULTIMATE"],
  "nfl-all-day": ["COMMON", "UNCOMMON", "RARE", "LEGENDARY", "ULTIMATE"],
}

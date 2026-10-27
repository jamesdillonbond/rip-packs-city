// lib/insights/first-mint-collections.ts
//
// The First-Mint Trophy board's collections (NFL All Day joined 2026-10-26, Top Shot parity pass 4): which views
// back each one, which MV-freshness key stamps it, and its tier vocabulary. PURE — no imports — because the client
// component reads it too, and the route imports the service-role Supabase client, which must never reach a browser.

export const FIRST_MINT_SOURCES = {
  "nba-top-shot": {
    trophies: "topshot_first_mint_trophies",
    stats: "topshot_first_mint_trophy_stats",
    mv: "first-mint",
    label: "Top Shot",
  },
  "nfl-all-day": {
    trophies: "allday_first_mint_trophies",
    stats: "allday_first_mint_trophy_stats",
    mv: "allday-first-mint",
    label: "NFL All Day",
  },
} as const
export type FirstMintCollection = keyof typeof FIRST_MINT_SOURCES

export const FIRST_MINT_COLLECTIONS = ["nba-top-shot", "nfl-all-day"] as const satisfies readonly FirstMintCollection[]

export function isFirstMintCollection(v: string | null | undefined): v is FirstMintCollection {
  return v === "nba-top-shot" || v === "nfl-all-day"
}

/** Tier vocabularies differ: All Day has UNCOMMON and no FANDOM. */
export const FIRST_MINT_TIERS: Record<FirstMintCollection, readonly string[]> = {
  "nba-top-shot": ["COMMON", "RARE", "LEGENDARY", "FANDOM", "ULTIMATE"],
  "nfl-all-day": ["COMMON", "UNCOMMON", "RARE", "LEGENDARY", "ULTIMATE"],
}

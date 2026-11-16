// lib/auth/anon-value-cta-copy.ts
//
// Wording + funnel surface for the signed-out "Own this …? Add your … to a free
// account" prompt on edition pages (components/auth/AnonCollectionValueCta.tsx),
// per collection (2026-11-16). A plain module, not "use client", so the server
// edition page can call it. A collection not listed here gets no prompt (null):
// the prompt must never name an identity the add-wallet form cannot take.
//
// The dashboard's add-wallet field takes a "Dapper username or wallet address"
// (and a Solana address for Candy), so the Dapper collections name the username.

export interface AnonValueCtaCopy {
  identityNoun: string
  itemNoun: string
  surface: string
}

const COPY: Record<string, AnonValueCtaCopy> = {
  "panini-blockchain": { identityNoun: "Panini username", itemNoun: "card", surface: "panini_edition" },
  "nba-top-shot": { identityNoun: "Top Shot username", itemNoun: "moment", surface: "topshot_edition" },
  "nfl-all-day": { identityNoun: "Dapper username", itemNoun: "moment", surface: "allday_edition" },
  "laliga-golazos": { identityNoun: "Dapper username", itemNoun: "moment", surface: "golazos_edition" },
  "disney-pinnacle": { identityNoun: "Dapper username", itemNoun: "pin", surface: "pinnacle_edition" },
  "candy-mlb": { identityNoun: "Candy wallet address", itemNoun: "card", surface: "candy_edition" },
}

export function anonValueCtaCopy(collection: string): AnonValueCtaCopy | null {
  return COPY[collection] ?? null
}

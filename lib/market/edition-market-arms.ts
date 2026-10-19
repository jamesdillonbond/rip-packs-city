// lib/market/edition-market-arms.ts
//
// Which Market arms are served by an RPC that filters set / series / team /
// player against `editions` in the database. Shared by /api/market (dispatch +
// the Owned filter) and /api/market/filter-options (the catalog dropdowns), so a
// new arm reaches every consumer at once — on 10-18 a hand list in each consumer
// left Golazos out of both the Owned filter and the catalog dropdowns.

export const TOPSHOT_MARKET_COLLECTION_ID = "95f28a17-224a-4025-96ad-adf8a4c63bfd"

// The edition-grain arms served by an RPC with get_allday_market_editions_v3's
// signature and columns. 2026-10-18: LaLiga Golazos joined (migration
// 20261018214307). It had NO arm, so /laliga-golazos/market fell through to v1
// cached_listings — Flowty's 100 rows against ~4.3k open on-chain asks, and an
// empty page on the day Flowty's API goes dark. One mapper for both, so the
// two cannot drift.
export const EDITION_MARKET_ARMS = {
  allday: { rpc: "get_allday_market_editions_v3", collectionId: "dee28451-5d62-409e-a1ad-a83f763ac070", source: "allday" },
  golazos: { rpc: "get_golazos_market_editions", collectionId: "06248cc4-b85f-47cd-af67-1855d14acd75", source: "golazos" },
} as const

/** Collections whose Market filters run in the database: Top Shot's sniper RPC plus every edition arm. */
export const DB_FILTERED_MARKET_COLLECTION_IDS: ReadonlySet<string> = new Set([
  TOPSHOT_MARKET_COLLECTION_ID,
  ...Object.values(EDITION_MARKET_ARMS).map((a) => a.collectionId),
])

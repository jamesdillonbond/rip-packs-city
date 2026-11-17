// lib/insights/market-index-collections.ts
//
// The RPC Index's collections (NFL All Day joined 2026-10-28, Top Shot parity) and everything that differs between
// them: the backing view, the tiers worth an index line, their colours, and each board's own URL + OG path.
// PURE — no imports — because MarketIndexClient (a client component) reads it; the server read is in
// lib/insights/market-index-board.ts.
//
// ⛔ One collection, one URL (docs/reference/architecture-notes.md, 10-27): All Day's board is /insights/allday-market
// with its own metadata, canonical and OG card — never /insights/market?collection=…, which no crawler or link
// unfurler can tell apart from Top Shot's.

export const MARKET_INDEX_COLLECTIONS = ["nba-top-shot", "nfl-all-day"] as const
export type MarketIndexCollection = (typeof MARKET_INDEX_COLLECTIONS)[number]

export function isMarketIndexCollection(v: string | null | undefined): v is MarketIndexCollection {
  return v === "nba-top-shot" || v === "nfl-all-day"
}

export interface MarketIndexConfig {
  label: string
  view: string
  /** Tiers that get an index line + headline card, in descending typical-value order. */
  plotTiers: readonly string[]
  /** Every tier value the view can carry (the API's ?tier= whitelist). */
  validTiers: readonly string[]
  /** Hardcoded hex — matches the --tier-* tokens; an SVG stroke cannot use CSS vars. */
  tierHex: Record<string, string>
  path: string
  ogPath: string
}

const TIER_HEX = {
  LEGENDARY: "#FFD700",
  ULTIMATE: "#FF6B35",
  RARE: "#818CF8",
  FANDOM: "#34D399",
  UNCOMMON: "#14B8A6",
  COMMON: "#94A3B8",
} as const

export const MARKET_INDEX_CONFIG: Record<MarketIndexCollection, MarketIndexConfig> = {
  "nba-top-shot": {
    label: "Top Shot",
    view: "topshot_market_index_daily",
    plotTiers: ["LEGENDARY", "RARE", "FANDOM", "COMMON", "ULTIMATE"],
    validTiers: ["ALL", "COMMON", "FANDOM", "RARE", "LEGENDARY", "ULTIMATE", "UNKNOWN"],
    tierHex: TIER_HEX,
    path: "/insights/market",
    ogPath: "/api/og/insights/market",
  },
  "nfl-all-day": {
    label: "NFL All Day",
    view: "allday_market_index_daily",
    // ULTIMATE is left out on purpose: 2 sales in the 120 days measured 10-28 — not an index (the page says so).
    plotTiers: ["LEGENDARY", "RARE", "UNCOMMON", "COMMON"],
    validTiers: ["ALL", "COMMON", "UNCOMMON", "RARE", "LEGENDARY", "ULTIMATE", "UNKNOWN"],
    tierHex: TIER_HEX,
    path: "/insights/allday-market",
    ogPath: "/api/og/insights/allday-market",
  },
}

/** The config for a validated collection — the one place the map is indexed. */
export function marketIndexConfig(c: MarketIndexCollection): MarketIndexConfig {
  return MARKET_INDEX_CONFIG[c]
}

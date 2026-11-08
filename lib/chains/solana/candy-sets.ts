// lib/chains/solana/candy-sets.ts
//
// Candy MLB's on-chain SETS (2026-11-08). Candy ships each product line as its own
// Metaplex Core collection with its own Magic Eden symbol; RPC catalogued only the
// first (2026 MLB Base Series ICONs) until today, so every All-Star, Gold Series and
// reward ICON a collector held was missing from their portfolio, and none of those
// markets was read. This registry is the one place a set is declared; every Candy
// lane (census, wallet backfill, sales, listings, offers) iterates it.
//
// Each set lives in RPC's ONE Candy collection (candy_mlb, 209ade70…) as a `sets` row;
// editions carry its `set_id`.
//
// ⛔ EDITION KEYS. The Base Series keys predate this file (`shohei-ohtani`,
// `bobby-witt-jr-yellow`) and are referenced by wmc, sales, listings, offers and
// URLs — they must never change, so the Base set has `editionKeyPrefix: null`.
// Every later set prefixes its keys AND appends the rarity, because the same player
// name recurs across sets ("Shohei Ohtani (17/50)" is an All-Star Rare, not the
// Base ICON) and across rarities within a set (Core /225, Uncommon /125, Rare /50).
//
// ⛔ PACKS. Only the Base Series writes `candy_packs`: candy_pack_market, the pack EV
// model and the treasury label all model THAT pack (10 ICONs, 15% Rainbow, $10). A
// later set's sealed packs are skipped, not mixed into the Base pack's supply.
//
// How to add a set: find one token's `updateAuthority` (= the Core collection
// address) and `collectionSymbol` from Magic Eden's public token API, add a `sets`
// row in a migration, add the entry here. The census picks it up on its next run.

export interface CandySet {
  /** Short stable id, used in edition-key prefixes and logs. */
  key: string
  /** sets.name — also written to editions.set_name for non-Base sets. */
  name: string
  /** sets.id (uuid). */
  setId: string
  /** Metaplex Core collection address (DAS getAssetsByGroup group_value). */
  collectionAddress: string
  /** Magic Eden collection symbol. */
  meSymbol: string
  /** null = the Base Series (legacy keys, no prefix). */
  editionKeyPrefix: string | null
  /** Only the Base Series feeds candy_packs. */
  writesPacks: boolean
}

// Discovered 2026-11-08 from Magic Eden's public token/collection API (one sample
// token per set; updateAuthority = the Core collection). The six Gold Series waves
// (Power, Next Gen, Rookies, Aces, 5 Tool Six, Award Winners) share ONE collection
// (six `Created` values under one symbol). No separate Rainbow-rewards or team-ball
// collection exists on Magic Eden.
export const CANDY_BASE_SET_ID = "381ae129-7dc7-47f4-9022-dd9e0fc21e39"

export const CANDY_SETS: readonly CandySet[] = [
  {
    key: "base26",
    name: "2026 MLB Base Series ICONs",
    setId: CANDY_BASE_SET_ID,
    collectionAddress: "JkJA4yUBweFQdKAWNDhoFj8zHMZrQ1uZEYfjbkc3p8n",
    meSymbol: "2026_mlb_base_series_icons_candy_digital",
    editionKeyPrefix: null,
    writesPacks: true,
  },
  {
    key: "asg26",
    name: "2026 MLB All-Star Game ICONs",
    setId: "8608ae96-10c5-4bf6-aedf-b0d4dc0bfe66",
    collectionAddress: "YTAPbbkLY6cqskMCtBfQXtN1x1a8smiKiM99svzQAvX",
    meSymbol: "2026_mlb_allstar_game_icons_candy_digital",
    editionKeyPrefix: "asg26",
    writesPacks: false,
  },
  {
    key: "gold26",
    name: "2026 MLB Gold Series ICONs",
    setId: "02fe803a-05b0-4af3-82b5-402e157d8d64",
    collectionAddress: "8BvHMsQZ2vihNBWFw3NcLYdpJzKsuz3kSrJUUwC5Lx4K",
    meSymbol: "gold_series_auction_1_candy_digital",
    editionKeyPrefix: "gold26",
    writesPacks: false,
  },
  {
    key: "quest26",
    name: "2026 MLB Base Series Collection Quest Rewards",
    setId: "29417ac1-1fb9-4346-bb08-e50253b618c8",
    collectionAddress: "BYSfa4LYpChyhLqvcB9o1vPp9riGUECPuaQ8tkw1ii5G",
    meSymbol: "base_series_collection_quests_candy_digital",
    editionKeyPrefix: "quest26",
    writesPacks: false,
  },
]

const BY_ADDRESS = new Map(CANDY_SETS.map((s) => [s.collectionAddress, s]))

/** The set a DAS asset belongs to, from its Core collection grouping; null if none of ours. */
export function candySetForAsset(asset: {
  grouping?: Array<{ group_key: string; group_value: string }>
}): CandySet | null {
  for (const g of asset.grouping ?? []) {
    if (g.group_key === "collection") {
      const s = BY_ADDRESS.get(g.group_value)
      if (s) return s
    }
  }
  return null
}

export function candySetByAddress(address: string): CandySet | null {
  return BY_ADDRESS.get(address) ?? null
}

/** Is this DAS asset in ANY Candy set we track? */
export function isCandySetAsset(asset: { grouping?: Array<{ group_key: string; group_value: string }> }): boolean {
  return candySetForAsset(asset) !== null
}

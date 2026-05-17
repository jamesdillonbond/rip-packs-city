// app/(collections)/[collection]/pack/[id]/types.ts
//
// Type contract for the get_pack_lifecycle(p_pack_nft_id text) Postgres RPC.
// The RPC returns a single jsonb object — supabase-js exposes it directly on
// `data` (no array wrap). All numeric monetary fields come back as either
// `number` or `string` depending on the underlying column type, so callers
// coerce defensively. Any field below documented as nullable can be null
// when the source data hasn't propagated yet (pack-events ingest, the
// editions backfill, or the wallet_moments_cache hydrator may not have
// caught up).
//
// Keep this in sync with the SQL function definition. If a new field is
// added to the RPC, add it here and reference-check the page render.

/** Status returned by get_pack_lifecycle. */
export type PackStatus = "sealed" | "ripped" | "unknown"

/** One leg of the ownership chain — a purchase or transfer event before the rip. */
export interface OwnershipEvent {
  /** UTC timestamp ISO string (e.g. "2026-04-12T08:32:11Z"). */
  timestamp: string
  /** Buyer 0x address. Always present for purchase rows. */
  buyer_address: string
  /** Seller 0x address. Null for first-mint / off-chain origination. */
  seller_address: string | null
  /** Sale price as a string or number — coerce with Number(). May be null for transfers. */
  price: number | string | null
  /** Currency symbol, e.g. "FLOW", "USDC", "DUC". Null on transfers. */
  currency: string | null
  /** Flow transaction hash (lowercase hex). Used to build a flowscan.io link. */
  tx_hash: string
  /** "purchase" | "transfer" | "mint" etc. — free-text classification from the indexer. */
  event_type?: string | null
}

/** The actual pack-opening event. Only present when status === "ripped". */
export interface RipEvent {
  /** Account that opened the pack — usually the last owner in the chain. */
  opener_address: string
  /** Flow tx hash of the OpenPack transaction. */
  tx_hash: string
  /** ISO timestamp the chain confirmed the rip. */
  sealed_at: string
  /** Count of moments minted/transferred out of the pack. */
  moments_pulled: number
}

/** A single moment pulled from the pack. */
export interface PackPull {
  /** On-chain moment NFT id. Always present. */
  nft_id: string
  /** Resolved editions.id — null until the hydrator has caught up. */
  edition_id: string | null
  /** Player / character display name. */
  player_name: string | null
  /** Set name (e.g. "Series 5 Common"). */
  set_name: string | null
  /** Tier enum string (COMMON / FANDOM / RARE / LEGENDARY / ULTIMATE for TS; or UFC vocab). */
  tier: string | null
  /** Per-edition serial. */
  serial_number: number | null
  /** Edition circulation cap — used for the "N/M" fraction. */
  circulation_count: number | null
  /** Thumbnail image URL. */
  thumbnail_url: string | null
  /** Looping video URL (used as hover preview / play affordance). */
  video_url: string | null
  /** Latest FMV in USD — null when no snapshot exists. */
  current_fmv: number | string | null
  /** Current 0x owner address — null when not yet resolved. */
  current_owner: string | null
}

/** Pre-computed rollups returned at the top level. */
export interface PackStats {
  /** Sum of all purchase prices in the ownership chain, normalized to USD. */
  total_cost_basis_usd: number | string | null
  /** Last purchase price in USD — basis for "delta vs cost". */
  last_cost_basis_usd: number | string | null
  /** Currency of last_cost_basis (display only — usd value is canonical). */
  last_cost_basis_currency: string | null
  /** Sum of every pulled moment's current_fmv. Null if any pull is unhydrated. */
  gross_pull_value_usd: number | string | null
  /** (gross_pull_value - total_cost_basis) / total_cost_basis. */
  roi_pct: number | string | null
}

export interface PackLifecycle {
  pack_nft_id: string
  collection_id: string
  /** Underscore-form db slug (nba_top_shot, etc.). */
  collection_slug: string
  /** Display-ready name, e.g. "2024-25 Common Pack". Null when the row is unknown. */
  pack_name: string | null
  status: PackStatus
  /** ISO timestamp of the first on-chain event observed for this pack. */
  first_seen_at: string | null
  ownership_chain: OwnershipEvent[]
  /** Present only when status === "ripped". */
  rip: RipEvent | null
  /** Present only when status === "ripped". Always an array (possibly empty if unhydrated). */
  pulls: PackPull[]
  stats: PackStats
  /** When set, the RPC encountered an issue (e.g. function-not-found upstream). */
  error?: string | null
}

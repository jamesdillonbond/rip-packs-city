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

/** One leg of the ownership chain — a purchase or transfer event before the rip.
 *  Field names mirror the snake_case keys emitted by the get_pack_lifecycle RPC's
 *  jsonb payload. supabase-js does NOT camelize jsonb keys, so accessors must
 *  read snake_case directly. */
export interface OwnershipEvent {
  /** UTC timestamp ISO string (e.g. "2026-04-12T08:32:11Z"). */
  sealed_at: string
  /** Buyer 0x address. Always present for purchase rows. */
  buyer_address: string
  /** Seller 0x address. Null for first-mint / off-chain origination. */
  seller_address: string | null
  /** Sale price as a string or number — coerce with Number(). May be null for transfers. */
  sale_price: number | string | null
  /** Currency symbol, e.g. "FLOW", "USDC", "DUC". Null on transfers. */
  sale_currency: string | null
  /** Flow transaction hash (lowercase hex). Used to build a flowscan.io link. */
  tx_hash: string
  /** Indexer-tagged event class, e.g. "DAPPER_MARKETPLACE". */
  custom_id?: string | null
  /** Block height for the on-chain event (optional, indexer-provided). */
  block_height?: number | null
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
  /** Block height of the rip transaction (optional). */
  block_height?: number | null
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
  /** Lowest live ASK in USD — optional. */
  floor_price?: number | string | null
  /** FMV confidence enum (HIGH / MEDIUM / LOW / SALES_ONLY / ASK_ONLY / NO_DATA / STALE). */
  confidence?: string | null
}

/** Resolved pack-distribution metadata. Two source paths:
 *
 *  - `drop_pool`        — full match against pack_distributions. Carries image,
 *                         title, tier, drop date, retail price, slot count and
 *                         live mint/open/sealed counters.
 *  - `purchase_metadata` — sparse fallback when only a pack_name could be
 *                         derived (e.g. reward packs without a drop_pool row).
 *                         title is populated; most other fields will be null.
 *
 *  When neither path resolves the whole `distribution` field on PackLifecycle
 *  is null and the page falls back to a bare "Pack #{id}" identity. */
export interface Distribution {
  dist_id: string | null
  title: string
  image_url: string | null
  /** Lower- or upper-case tier label, e.g. "common" / "LEGENDARY". */
  tier: string | null
  retail_price_usd: number | null
  /** ISO timestamp of the drop release date. */
  drop_date: string | null
  pack_slots: number | null
  total_minted: number | null
  total_opened: number | null
  total_sealed: number | null
  /** 0–100 percent — share of minted packs that have been opened. */
  depletion_pct: number | null
  source: "drop_pool" | "purchase_metadata"
}

/** Pre-computed rollups returned at the top level.
 *  Field names mirror the snake_case keys emitted by the RPC's jsonb payload. */
export interface PackStats {
  /** Sum of all purchase prices in the ownership chain, in the cost-basis currency.
   *  For DUC packs this is also USD (DUC is 1:1 USD-pegged). */
  total_cost_basis: number | string | null
  /** Currency of total_cost_basis. */
  currency: string | null
  /** Sum of every pulled moment's current_fmv in USD. Null if any pull is unhydrated. */
  gross_pull_value_usd: number | string | null
  /** Number of pulls in the pack. */
  pull_count?: number | null
  /** Pulls that had a current_fmv resolved. */
  pulls_with_fmv?: number | null
}

export interface PackLifecycle {
  pack_nft_id: string
  collection_id: string
  /** Underscore-form db slug (nba_top_shot, etc.). */
  collection_slug: string
  /** Display-ready name, e.g. "2024-25 Common Pack". Null when the row is unknown. */
  pack_name: string | null
  /** Resolved distribution metadata — null when neither drop_pool nor
   *  purchase_metadata resolution succeeded. See Distribution. */
  distribution: Distribution | null
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

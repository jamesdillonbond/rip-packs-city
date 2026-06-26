// lib/chains/panini/normalize.ts
//
// Maps a Plane-A feed row (PaniniRawEdition) onto the panini_editions side-table
// shape (drafted in docs/drafts/panini/panini-schema.sql — NOT yet applied).
// Panini's parallel/insert ladder diverges from the generic uuid-keyed `editions`
// table, so it lives in its own table like Pinnacle (pinnacle_editions).
//
// Inert until go-live: the feed returns [] until PANINI_FEED_MODE + creds are set
// (lib/chains/panini/feed.ts), so nothing iterates this pre-launch.
//
// Invariant: still_in_packs is a GENERATED column (mintCap − pulled_count) — never
// write it here; only pulled_count + mint_cap feed it.

import type { PaniniRawEdition } from "./feed"

// Collection UUID in public.collections (seeded inert 2026-06-08).
export const PANINI_UUID = "d1a0a7f5-609a-49f4-a1a7-4eaac55b020b"

// Long-form collection slug (collections.slug convention).
export const PANINI_SLUG = "panini_blockchain"

// Panini sheet rarity label → RPC tier_type enum
// (COMMON / FANDOM / RARE / LEGENDARY / ULTIMATE). Per the product spec ladder.
const TIER: Record<string, string> = {
  Uncommon: "COMMON",
  Rare: "RARE",
  "Ultra Rare": "RARE",
  Epic: "LEGENDARY",
  Legendary: "ULTIMATE",
}

// Classify a (set, parallel) into the parallel_family bucket the squeeze / EV
// surfaces group on. FOTL-exclusive parallels (Aguila/Maple Leaf/Old Glory/
// Nebula) are flagged by the feed, not inferred from the name.
export function parallelFamily(set: string, parallel: string, fotl?: boolean): string {
  if (fotl) return "fotl_exclusive"
  if (set.toLowerCase().startsWith("base")) return "base"
  if (/silver|gold|black/i.test(parallel)) return "tiered_insert"
  return "non_tiered_insert"
}

// One panini_editions row (dedup on external_id,collection_id). Column names
// match panini-schema.sql §1 exactly. still_in_packs / created_at / updated_at
// are DB-managed (generated / defaulted) and intentionally omitted.
export interface PaniniEditionRow {
  id: string
  external_id: string
  collection_id: string
  player_name: string | null
  nation: string | null
  set_name: string | null
  parallel: string | null
  parallel_family: string
  rarity_label: string | null
  tier: string | null
  mint_cap: number | null
  pulled_count: number
  is_fotl_exclusive: boolean
  serial_low_ask_usd: number | null
  thumbnail_url: string | null
  video_url: string | null
  last_seen_at: string
}

export function toEditionRow(r: PaniniRawEdition, nowIso: string): PaniniEditionRow {
  return {
    id: r.id,
    // Stable RPC key: set:player:parallel, whitespace-collapsed. Confirm against
    // the live feed at go-live that this triple is unique per edition.
    external_id: `${r.set}:${r.player}:${r.parallel}`.replace(/\s+/g, "_"),
    collection_id: PANINI_UUID,
    player_name: r.player || null,
    nation: r.nation ?? null,
    set_name: r.set || null,
    parallel: r.parallel || null,
    parallel_family: parallelFamily(r.set, r.parallel, r.isFotlExclusive),
    rarity_label: r.rarity ?? null,
    tier: TIER[r.rarity ?? ""] ?? null,
    mint_cap: Number.isFinite(r.mintCap) ? Math.trunc(r.mintCap) : null,
    pulled_count: Number.isFinite(r.circulation) ? Math.max(0, Math.trunc(r.circulation)) : 0,
    is_fotl_exclusive: !!r.isFotlExclusive,
    serial_low_ask_usd: typeof r.floorAskUsd === "number" ? r.floorAskUsd : null,
    thumbnail_url: r.thumbnailUrl ?? null,
    video_url: r.videoUrl ?? null,
    last_seen_at: nowIso,
  }
}

// lib/chains/solana/normalize.ts
//
// THE ONLY discovery-coupled file in the Candy ingest. Everything here maps a
// raw Metaplex Core DAS asset onto RPC's `editions` / `wallet_moments_cache` /
// `sales` shapes. Five values (the TODOs below) are unknowable until Item 0
// discovery — Candy's secondary trading opening on Solana / Magic Eden gives us
// a live asset to read. Until then the Candy collection is inert
// (is_active=false, id 209ade70…) so nothing iterates these.
//
// When discovery lands: fill the 5 TODOs from 2–3 live assets in the SAME
// edition (confirm what's constant across serials for editionKeyFromAsset), run
// each route once manually, verify counts, THEN wire crons + watchlist.
//
// Invariant (memory: wmc-edition-key-contract): wmc.edition_key MUST equal
// editions.external_id for the same card. normalizeSerial + normalizeEdition
// derive both from editionKeyFromAsset so they can never diverge.

import type { DasAsset } from "./das"

// Collection UUID in public.collections (seeded inert 2026-06-08).
export const CANDY_MLB_UUID = "209ade70-32c5-4470-bc7c-4793d660f713"

// Long-form collection slug. editions.collection + sales.collection are
// NOT NULL text and use the long-form vocabulary (nba_top_shot, nfl_all_day…).
export const CANDY_MLB_SLUG = "candy_mlb"

// ── DISCOVERY TODOs (resolve all 5 at Item 0) ──────────────────────────────

// TODO_1: the Metaplex Core collection mint (the grouping group_value). Read it
// off any live Candy asset's `grouping[].group_value`.
export const CANDY_MLB_COLLECTION_ADDRESS = "TODO_1_CANDY_CORE_COLLECTION_ADDRESS"

// TODO_2: the Magic Eden collection symbol used by the activities/listings/stats
// endpoints (https://api-mainnet.magiceden.dev/v2/collections/{symbol}/…).
export const CANDY_MLB_ME_SYMBOL = "TODO_2_CANDY_ME_SYMBOL"

// TODO_3 / TODO_4: which on-chain attribute trait_type holds the serial number
// and the edition size / print run. Compared lowercased in attrMap().
export const SERIAL_ATTR_KEY = "TODO_3_serial_attr"
export const EDITION_SIZE_ATTR_KEY = "TODO_4_edition_size_attr"

// Fold content.metadata.attributes into a lowercased-key map for safe lookup.
export function attrMap(asset: DasAsset): Record<string, string> {
  const out: Record<string, string> = {}
  const attrs = asset.content?.metadata?.attributes ?? []
  for (const a of attrs) {
    if (a?.trait_type == null) continue
    out[String(a.trait_type).toLowerCase()] = a.value == null ? "" : String(a.value)
  }
  return out
}

function attr(asset: DasAsset, key: string): string | undefined {
  const v = attrMap(asset)[key.toLowerCase()]
  return v === "" ? undefined : v
}

function toIntOrNull(v: string | undefined): number | null {
  if (v == null) return null
  const n = Number(String(v).replace(/[^0-9.-]/g, ""))
  return Number.isFinite(n) ? Math.trunc(n) : null
}

// TODO_5: the stable per-edition key — what groups serialized assets into one
// "card"/edition. This becomes editions.external_id (and wmc.edition_key).
//
// Candidates to confirm against 2–3 live assets in the same edition:
//   (a) a set/card attribute pair, e.g. `${attr(set)}:${attr(card)}` — PREFERRED
//       if such attributes exist and are constant across serials.
//   (b) the asset name with the per-serial suffix stripped (e.g. drop "#12/100").
//
// The fallback below is a slug of the name with a trailing "#…"/"N/M" serial
// fragment removed. It is a PLACEHOLDER — verify it is actually constant across
// serials before the first production run, or attribution will be wrong.
export function editionKeyFromAsset(asset: DasAsset): string {
  // Prefer an explicit attribute pair once discovery confirms the keys.
  // const set = attr(asset, "set"); const card = attr(asset, "card")
  // if (set && card) return `${set}:${card}`.toLowerCase()

  const name = asset.content?.metadata?.name ?? asset.id
  return name
    .replace(/#\s*\d+\s*(\/\s*\d+)?\s*$/i, "") // strip "#12" / "#12/100"
    .replace(/\b\d+\s*\/\s*\d+\s*$/i, "") // strip bare "12/100"
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9:_-]/g, "")
    || asset.id
}

// One editions row (dedup on external_id,collection_id). `collection` is the
// NOT NULL long-form slug; `collection_id` the FK.
export interface NormalizedEdition {
  external_id: string
  collection_id: string
  collection: string
  name: string | null
  circulation_count: number | null
  thumbnail_url: string | null
  video_url: string | null
  player_name: string | null
  set_name: string | null
}

export function normalizeEdition(asset: DasAsset): NormalizedEdition {
  const meta = asset.content?.metadata
  const image =
    asset.content?.links?.image ??
    asset.content?.files?.find((f) => (f.mime ?? "").startsWith("image"))?.uri ??
    asset.content?.files?.[0]?.uri ??
    null
  const video =
    asset.content?.links?.animation_url ??
    asset.content?.files?.find((f) => (f.mime ?? "").startsWith("video"))?.uri ??
    null
  return {
    external_id: editionKeyFromAsset(asset),
    collection_id: CANDY_MLB_UUID,
    collection: CANDY_MLB_SLUG,
    name: meta?.name ?? null,
    circulation_count: toIntOrNull(attr(asset, EDITION_SIZE_ATTR_KEY)),
    thumbnail_url: image,
    video_url: video,
    // Player / set attribute keys also resolve at discovery; safe to leave null
    // (editions.player_name / set_name are nullable). Wire once confirmed.
    player_name: attr(asset, "player") ?? null,
    set_name: attr(asset, "set") ?? null,
  }
}

// One wallet_moments_cache row (dedup on wallet_address,collection_id,moment_id).
// moment_id = the per-serial mint pubkey. edition_key === editions.external_id.
export interface NormalizedSerial {
  wallet_address: string
  collection_id: string
  moment_id: string
  edition_key: string
  serial_number: number | null
  image_url: string | null
}

export function normalizeSerial(asset: DasAsset): NormalizedSerial {
  const image =
    asset.content?.links?.image ??
    asset.content?.files?.find((f) => (f.mime ?? "").startsWith("image"))?.uri ??
    asset.content?.files?.[0]?.uri ??
    null
  return {
    wallet_address: asset.ownership?.owner ?? "",
    collection_id: CANDY_MLB_UUID,
    moment_id: asset.id,
    edition_key: editionKeyFromAsset(asset),
    serial_number: toIntOrNull(attr(asset, SERIAL_ATTR_KEY)),
    image_url: image,
  }
}

// True once the collection-address TODO is filled — routes guard on this so an
// accidental run before discovery is a clean no-op instead of hammering DAS
// with a placeholder group value.
export function candyDiscoveryReady(): boolean {
  return !CANDY_MLB_COLLECTION_ADDRESS.startsWith("TODO_")
}

export function candyMeSymbolReady(): boolean {
  return !CANDY_MLB_ME_SYMBOL.startsWith("TODO_")
}

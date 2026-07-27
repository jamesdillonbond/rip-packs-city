// lib/chains/solana/normalize.ts
//
// THE ONLY discovery-coupled file in the Candy ingest. Everything here maps a
// raw Metaplex Core DAS asset onto RPC's `editions` / `wallet_moments_cache` /
// `sales` shapes.
//
// DISCOVERY COMPLETE — 2026-07-17 (Cowork). Drop 1 sold out before Trevor could
// buy a pack, so the five values were resolved live from the actual Drop-1 mints
// via Magic Eden's public token API (secret-free), cross-checked on Tensor.
// Ground-truth sample assets (all share the same on-chain collection):
//   ICON  "Aaron Judge (248/250)"            umccuiZv1FA46KdbAX7cRcP3h2PXki7q4PBL5WU2MSS
//   ICON  "Bobby Witt Jr. - YELLOW (13/15)"  (Rainbow parallel — /15, colour in the NAME)
//   PACK  "2026 MLB Base Series ICONs (1444/2500)"  Item Type=Pack  -> SKIPPED (not a moment)
// Key findings encoded below:
//   * collection address (updateAuthority, identical across packs + every ICON)
//   * the colour of a Rainbow parallel lives in the NAME ("... - YELLOW (...)"),
//     NOT in a trait — there is NO Rainbow/Colour/First-Mint trait on Drop 1.
//   * both Core and Rainbow report Rarity="CORE", so Rarity does NOT distinguish
//     the parallel — the NAME (and edition size 250 vs 15) does.
//   * the collection MIXES sealed pack assets (Item Type=Pack) with the ICONs
//     (Item Type=Collectible) — the editions/wmc ingest must skip packs.
//
// Invariant (memory: wmc-edition-key-contract): wmc.edition_key MUST equal
// editions.external_id for the same card. normalizeSerial + normalizeEdition
// derive both from editionKeyFromAsset so they can never diverge.

import type { DasAsset } from "./das"

// Collection UUID in public.collections (seeded inert 2026-06-08).
export const CANDY_MLB_UUID = "209ade70-32c5-4470-bc7c-4793d660f713"

// Long-form collection slug. editions.collection + sales.collection are
// NOT NULL text and use the long-form vocabulary (nba_top_shot, nfl_all_day...).
export const CANDY_MLB_SLUG = "candy_mlb"

// -- DISCOVERY-RESOLVED CONSTANTS (2026-07-17) ------------------------------

// The Metaplex Core collection mint — the DAS getAssetsByGroup group_value.
// Every pack + ICON in the drop carries this as its on-chain update authority
// (verified across 5 sample assets: 2 ICONs + 3 packs, different players/types).
export const CANDY_MLB_COLLECTION_ADDRESS = "JkJA4yUBweFQdKAWNDhoFj8zHMZrQ1uZEYfjbkc3p8n"

// The Magic Eden collection symbol. CONFIRMED 2026-07-17, ARMED 2026-07-19 after
// re-verifying live: /v2/collections/<symbol>/stats resolves (listedCount 0) and
// /v2/collections/<symbol>/activities returns real rows.
// It was previously held as a TODO placeholder to keep candy-sales-indexer a clean
// no-op until secondary SALES open. The indexer already guarantees that better:
// SALE_TYPES = {buyNow, buyNowFill, acceptBid} excludes "bid", so while listings
// stay suppressed by the quest-hold rule the ARMED indexer finds 0 sales and writes
// nothing — an equally clean no-op that ALSO captures the first real sale the moment
// it prints, instead of waiting for a human to notice and flip a constant.
export const CANDY_MLB_ME_SYMBOL = "2026_mlb_base_series_icons_candy_digital"

// TODO_3 RESOLVED — the on-chain serial trait is `serial_number` (a clean
// integer, isOnChain:true). NOT "Serial Number", which is the "248/250" display
// string (its denominator is the edition size — see editionSizeFromAsset).
export const SERIAL_ATTR_KEY = "serial_number"

// TODO_4 RESOLVED — edition size is NOT a standalone trait; it is the denominator
// of the "Serial Number" display trait ("248/250" -> 250, "13/15" -> 15). Kept as
// the display-trait key; editionSizeFromAsset() parses the denominator.
export const EDITION_SIZE_ATTR_KEY = "Serial Number"

// The five Rainbow parallel colours (recon 2026-07-16). On Drop 1 the colour is
// carried in the ASSET NAME ("Bobby Witt Jr. - YELLOW (13/15)"), not a trait.
const RAINBOW_COLORS = ["orange", "yellow", "green", "blue", "pink"]

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

// Metaplex Core native burn (the Diamond Economy's core mechanic — Candy
// confirmed burn-for-credits on X 2026-07-15). DAS keeps burnt assets in
// group/owner listings with `burnt: true`; a burnt asset must never create or
// refresh an editions/wmc row (ownership is stale, the serial left circulation).
// Sales history is unaffected — burns are not sales. Expect Candy circulation
// counts to DECREASE over time; do not treat a shrinking count as an error.
export function isBurnt(asset: DasAsset): boolean {
  return asset.burnt === true
}

// The collection MIXES sealed PACK assets (Item Type=Pack) with the individual
// ICONs (Item Type=Collectible). Packs are NOT editions/moments — they belong to
// the pack pipeline — so the editions + wmc ingests must skip them.
export function isPack(asset: DasAsset): boolean {
  return (attr(asset, "Item Type") ?? "").toLowerCase() === "pack"
}

// The asset name with its trailing serial fragment removed:
//   "Aaron Judge (248/250)"           -> "Aaron Judge"
//   "Bobby Witt Jr. - YELLOW (13/15)" -> "Bobby Witt Jr. - YELLOW"
//   "Mike Trout #12/100"              -> "Mike Trout"
// The Rainbow colour survives (it is part of the name), so distinct colours map
// to distinct editions while every serial of one card maps to the same base.
function baseName(asset: DasAsset): string {
  const name = asset.content?.metadata?.name ?? ""
  return name
    .replace(/\s*\(\s*\d+\s*\/\s*\d+\s*\)\s*$/i, "")
    .replace(/\s*#?\s*\d+\s*\/\s*\d+\s*$/i, "")
    .replace(/\s*#\s*\d+\s*$/i, "")
    .replace(/\s+\d+\s*$/i, "") // bare trailing serial ("... - GREEN 10")
    .trim()
}

// Rainbow colour from the NAME (Drop 1's encoding: "... - YELLOW (...)"). Falls
// back to attribute probes in case a future drop moves the colour on-chain.
export function rainbowColorFromAsset(asset: DasAsset): string | null {
  const name = (asset.content?.metadata?.name ?? "").toLowerCase()
  for (const c of RAINBOW_COLORS) {
    if (new RegExp(`[-]\\s*${c}\\b`).test(name)) return c
  }
  const m = attrMap(asset)
  const v =
    m["rainbow insert"] ?? m["rainbow variant"] ?? m["rainbow"] ?? m["insert"] ?? m["variant"] ?? m["parallel"] ?? m["color"]
  if (!v) return null
  const c = v.trim().toLowerCase()
  if (!c || c === "none" || c === "false" || c === "no") return null
  return c
}

// First-Mint debut. Drop 1 carried NO dedicated on-chain trait for this (it is a
// marketing designation), so this probes candidate trait keys and returns false
// when absent — harmless, and a head start if a drop adds one.
export function isFirstMint(asset: DasAsset): boolean {
  const m = attrMap(asset)
  const v = (m["first mint"] ?? m["first_mint"] ?? m["firstmint"] ?? m["first mint debut"] ?? "")
    .trim()
    .toLowerCase()
  return v === "true" || v === "yes" || v === "1"
}

// TODO_5 RESOLVED — the stable per-edition key is the base-name slug. Because the
// Rainbow colour lives in the name, this differentiates each colour into its own
// edition and stays constant across serials of one card. Packs are filtered out
// upstream, so their base name never lands here.
export function editionKeyFromAsset(asset: DasAsset): string {
  const src = baseName(asset) || asset.content?.metadata?.name || asset.id || ""
  const slug = src
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9:_-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
  return slug || asset.id
}

// Edition size = denominator of the "Serial Number" display trait ("248/250").
export function editionSizeFromAsset(asset: DasAsset): number | null {
  const disp = attr(asset, EDITION_SIZE_ATTR_KEY)
  if (disp && disp.includes("/")) {
    const denom = toIntOrNull(disp.split("/")[1])
    if (denom && denom > 0) return denom
  }
  return null
}

// Serial number = numerator of the "Serial Number" display trait ("9/15" -> 9).
// Helius DAS surfaces "Serial Number" but NOT the on-chain "serial_number" trait,
// so parse the numerator; fall back to the on-chain trait, then a bare trailing
// integer in the name (some Rainbow names read "... - GREEN 10", not "(10/15)").
export function serialFromAsset(asset: DasAsset): number | null {
  const disp = attr(asset, EDITION_SIZE_ATTR_KEY)
  if (disp && disp.includes("/")) {
    const num = toIntOrNull(disp.split("/")[0])
    if (num != null) return num
  }
  const s = toIntOrNull(attr(asset, SERIAL_ATTR_KEY))
  if (s != null) return s
  const m = (asset.content?.metadata?.name ?? "").match(/(\d+)\s*$/)
  return m ? toIntOrNull(m[1]) : null
}

function imageUrl(asset: DasAsset): string | null {
  return (
    asset.content?.links?.image ??
    asset.content?.files?.find((f) => (f.mime ?? "").startsWith("image"))?.uri ??
    asset.content?.files?.[0]?.uri ??
    null
  )
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
  team_name: string | null
  badges: string[] | null
  // The number worn in the moment, from the "Player Number" trait. This is the
  // SAME column Top Shot and All Day fill (editions.jersey_number, 65% and 88%
  // filled respectively) and the same one that powers the jersey-match
  // special-serial row — so Candy jerseys belong here, not in a Candy-only side
  // table. Null when the trait is absent or unparseable.
  jersey_number: number | null
}

// editions.badges (text[]) — best-effort from name (Rainbow) + trait probes
// (First Mint). Null (not []) when nothing matched, mirroring the Flow collections.
function editionBadges(asset: DasAsset): string[] | null {
  const out: string[] = []
  if (isFirstMint(asset)) out.push("First Mint")
  const color = rainbowColorFromAsset(asset)
  if (color) out.push(`Rainbow (${color.charAt(0).toUpperCase() + color.slice(1)})`)
  return out.length ? out : null
}

export function normalizeEdition(asset: DasAsset): NormalizedEdition {
  const video =
    asset.content?.links?.animation_url ??
    asset.content?.files?.find((f) => (f.mime ?? "").startsWith("video"))?.uri ??
    null
  return {
    external_id: editionKeyFromAsset(asset),
    collection_id: CANDY_MLB_UUID,
    collection: CANDY_MLB_SLUG,
    name: baseName(asset) || asset.content?.metadata?.name || null,
    circulation_count: editionSizeFromAsset(asset),
    thumbnail_url: imageUrl(asset),
    video_url: video,
    player_name: attr(asset, "Player Name") ?? null,
    set_name: null,
    team_name: attr(asset, "Team") ?? null,
    badges: editionBadges(asset),
    jersey_number: jerseyFromAsset(asset),
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
  return {
    wallet_address: asset.ownership?.owner ?? "",
    collection_id: CANDY_MLB_UUID,
    moment_id: asset.id,
    edition_key: editionKeyFromAsset(asset),
    serial_number: serialFromAsset(asset),
    image_url: imageUrl(asset),
  }
}

// Jersey number from the "Player Number" trait ("#99" -> 99).
//
// The board's Serials footnote used to state that "Candy players carry no
// jersey number". That was FALSE — verified 2026-07-27 on three independent
// mints (Aaron Judge #99, Manny Machado #13, Mike Trout #27). Every ICON
// carries the trait; the ingest simply read player_name and team out of the
// same attribute map and dropped this one. A jersey match is therefore
// computable exactly as on Flow: serial_number = jersey number.
export function jerseyFromAsset(asset: DasAsset): number | null {
  return toIntOrNull(attr(asset, "Player Number"))
}

// NOTE (2026-07-27): there was briefly a NormalizedPlayerNumber / a
// `candy_player_numbers` table here. That was a mistake — `editions.jersey_number`
// is the platform-wide canonical home for exactly this value (Top Shot 65% filled,
// All Day 88%, both feeding the jersey-match special-serial row), so a Candy-only
// parallel table would have forced Candy-specific code into every downstream
// consumer and put Candy out of parity on a field the other collections share.
// jerseyFromAsset() now feeds normalizeEdition() instead, and the table was
// dropped before it ever held a row.

// One candy_packs row. Packs are NOT editions (no player, no edition key) —
// they are the sealed product, and the collection mixes them in with the ICONs.
// We keep burnt rows (unlike cards, where a burnt asset never refreshes a row).
//
// CORRECTED 2026-07-27 — this comment previously asserted "a BURNT pack is an
// OPENED pack (Metaplex Core burn is how a pack is redeemed)". That is FALSE, and
// the first full walk disproved it: is_burnt is false on all 2,501 pack assets
// while 700+ packs have demonstrably been opened (an opened pack returns to the
// treasury rather than being burnt). So is_burnt is NOT an opened-pack signal,
// and candy_pack_market deliberately publishes no sealed-vs-opened split.
export interface NormalizedPack {
  token_mint: string
  collection_id: string
  serial_number: number | null
  pack_supply: number | null
  owner: string | null
  is_burnt: boolean
  name: string | null
  image_url: string | null
}

export function normalizePack(asset: DasAsset): NormalizedPack {
  return {
    token_mint: asset.id,
    collection_id: CANDY_MLB_UUID,
    serial_number: serialFromAsset(asset),
    // Denominator of the "Serial Number" display trait — 2,500 on Drop 1.
    pack_supply: editionSizeFromAsset(asset),
    owner: asset.ownership?.owner ?? null,
    is_burnt: isBurnt(asset),
    name: asset.content?.metadata?.name ?? null,
    image_url: imageUrl(asset),
  }
}

// True once the collection-address TODO is filled — routes guard on this so an
// accidental run before discovery is a clean no-op instead of hammering DAS with
// a placeholder group value.
export function candyDiscoveryReady(): boolean {
  return !CANDY_MLB_COLLECTION_ADDRESS.startsWith("TODO_")
}

export function candyMeSymbolReady(): boolean {
  return !CANDY_MLB_ME_SYMBOL.startsWith("TODO_")
}

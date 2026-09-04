// app/api/market/route.ts
//
// Phase 4 — Market browser API.
//
// Collection-aware listing feed pulled from cached_listings (which is already
// fully denormalized — player_name, team_name, set_name, tier, serial_number,
// ask_price, fmv, thumbnail_url, badge_slugs live on the row). Replaces the
// old NBA-only badge_editions version.
//
// Phase 4 additions:
//   - team (multi-select)
//   - badges (multi-select; intersects cached_listings.badge_slugs)
//   - specialSerials toggle (#1, last-serial)
//   - per-row editionKey derived via editions JOIN on (player_name, set_name)
//     so the client can join against /api/wallet/edition-counts for the
//     "Edition Owned / Locked" column. TS uses set_id_onchain:play_id_onchain
//     (matches the integer form in wallet_moments_cache); other collections
//     use editions.external_id (already the canonical wmc edition_key shape).
//
// Outlier clamp:
//   cached_listings on thin-volume collections (notably LaLiga Golazos) gets
//   polluted by $1M sentinel ask prices — real user listings priced against
//   an unattainable floor to troll or reserve. We apply hard tier-based
//   ceilings server-side to every collection, not just Golazos, since these
//   leak into every feed. Ceilings follow the Phase 3 spec: Common < $500,
//   Rare < $50K, Legendary < $250K, Ultimate < $1M. Fandom/Uncommon/Contender
//   follow their nearest analog (< $500 / < $50K).
//
// Pagination:
//   Server-side via range(). Max 1000 rows per query, default page size 50.
//   Response includes { total, page, hasMore } so the client doesn't have to
//   eat a 1000-row payload for UI-side paging.

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { loadTopshotFmvGuard, guardTopshotFmv, type FmvGuardMap } from "@/lib/fmv-display-guard"
import { apiErrorResponse } from "@/lib/api-error"
import { boundedRead } from "@/lib/api/bounded-read"

export const dynamic = "force-dynamic"
// AllDay's get_allday_market_listings was rewritten for LIMIT-pushdown (~62ms), but
// the TS leg (get_topshot_sniper_deals) still evaluates a per-edition FMV lateral for
// its ~3k badge_editions rows to rank by discount (~12s cold, ~2s warm) — that sort is
// fundamental to the deal feed and the RPC is shared with /api/sniper-feed, so it is
// left as-is. 10s was below its cold latency and 504'd; 30 fits under service_role's
// 30s DB statement_timeout while the s-maxage=90 CDN cache absorbs cold hits.
export const maxDuration = 30

const TS_COLLECTION_ID = "95f28a17-224a-4025-96ad-adf8a4c63bfd"

// Tier ceilings — ask prices above these are treated as sentinels and dropped.
// Keys are upper-cased raw tier strings as stored in cached_listings.tier.
const TIER_CEILING: Record<string, number> = {
  COMMON:     500,
  FANDOM:     500,
  UNCOMMON:   500,
  CONTENDER:  500,
  RARE:       50_000,
  CHALLENGER: 50_000,
  LEGENDARY:  250_000,
  CHAMPION:   250_000,
  ULTIMATE:   1_000_000,
}

// Absolute maximum across all tiers. Anything past this is always a sentinel.
const ABSOLUTE_CEILING = 1_000_000

const MAX_LIMIT = 1000
const DEFAULT_LIMIT = 50

type SortKey =
  | "price_asc" | "price_desc"
  | "discount_asc" | "discount_desc"
  | "fmv_asc" | "fmv_desc"
  | "recent"

const ALLOWED_SORTS: Set<SortKey> = new Set([
  "price_asc", "price_desc",
  "discount_asc", "discount_desc",
  "fmv_asc", "fmv_desc",
  "recent",
])

function computeDiscount(ask: number | null, fmv: number | null): number | null {
  if (ask == null || fmv == null || fmv <= 0) return null
  return Math.round(((fmv - ask) / fmv) * 1000) / 10
}

function normJoinKey(player: string | null | undefined, set: string | null | undefined): string | null {
  if (!player || !set) return null
  return `${String(player).trim().toLowerCase()}|${String(set).trim().toLowerCase()}`
}

// Collapse per-listing (serial-grain) enriched rows into one row per edition
// (Trevor's Market=edition / Sniper=serial split). Used on the legacy
// cached_listings path (Golazos / UFC — tiny feeds where an in-memory group-by
// is fine; AllDay/TS/Pinnacle aggregate at their source instead). Floor ask =
// the group's minimum ask, listedCount = the group size, discount recomputed off
// the floor. Per-serial affordances (serial, single-moment buy link) are dropped
// — those belong on Sniper.
function collapseToEditions(rows: any[]): any[] {
  const groups = new Map<string, any[]>()
  for (const r of rows) {
    const key: string =
      r.editionKey ||
      (r.playerName && r.setName
        ? `${String(r.playerName).toLowerCase().trim()}|${String(r.setName).toLowerCase().trim()}|${String(r.tier ?? "").toLowerCase()}`
        : String(r.id))
    const g = groups.get(key)
    if (g) g.push(r)
    else groups.set(key, [r])
  }
  const out: any[] = []
  for (const g of groups.values()) {
    let rep = g[0]
    let floor: number | null = rep.askPrice
    let fmv: number | null = null
    let listedAt: string | null = rep.listedAt
    for (const r of g) {
      if (r.askPrice != null && (floor == null || r.askPrice < floor)) { floor = r.askPrice; rep = r }
      if (r.fmv != null && (fmv == null || r.fmv > fmv)) fmv = r.fmv
      if (r.listedAt && (!listedAt || Date.parse(r.listedAt) > Date.parse(listedAt))) listedAt = r.listedAt
    }
    out.push({
      ...rep,
      askPrice: floor,
      fmv,
      discount: computeDiscount(floor, fmv),
      listedCount: g.length,
      serialNumber: null,
      // Carry the REPRESENTATIVE (floor-ask) listing's special-serial flag, so
      // ?specialSerials=true means the same thing here as on the modern path:
      // "this edition's headline listing is a #1 or a perfect (#N/N) mint".
      // Before 2026-08-02 this was hardcoded false while the specialSerials
      // predicate ran AFTER the collapse, so the filter could only ever return
      // an EMPTY board on this path (Golazos / UFC). serialNumber stays null —
      // Market is edition-grain and the per-serial affordances still belong on
      // Sniper; this is a flag, not a serial.
      isSpecialSerial: !!rep.isSpecialSerial,
      flowId: null,   // no single on-chain moment at edition grain
      buyUrl: null,   // per-serial listing link belongs on Sniper
      listedAt,
    })
  }
  return out
}

interface EditionRow {
  external_id: string | null
  collection_id: string
  player_name: string | null
  set_name: string | null
  set_id_onchain: number | null
  play_id_onchain: number | null
  badges: string[] | null
}

// Per-collection edition-metadata lookup, keyed by normJoinKey(player, set). It
// backfills the on-chain edition key (TS integer form) + edition-wide badges
// onto market rows that don't carry their own (TS sniper rows arrive with
// edition_key/badge_slugs null — for them this lookup is load-bearing).
//
// PostgREST caps an unbounded select at 1,000 rows, so the old bare .limit(50000)
// silently returned only 1,000 of a collection's editions (TS has ~19k, AllDay
// ~6k) and left most rows un-enriched (null edition links, no badges). The whole
// catalog is now paged in with .range(). The completed map is memoized per
// collection (10-min TTL) so a hot Market surface doesn't rebuild it every
// request — net FEWER queries than the old one-per-request fetch. A partial map
// from a mid-page error is returned but NOT cached, so the next request retries.
const editionLookupCache = new Map<string, { expiresAt: number; map: Map<string, EditionRow> }>()
const EDITION_LOOKUP_TTL_MS = 10 * 60 * 1000
// Disabled under test so each case rebuilds from its own mock (no cross-case bleed).
const EDITION_LOOKUP_MEMO = process.env.NODE_ENV !== "test"

async function loadEditionLookup(collectionId: string): Promise<Map<string, EditionRow>> {
  const nowMs = Date.now()
  if (EDITION_LOOKUP_MEMO) {
    const cached = editionLookupCache.get(collectionId)
    if (cached && cached.expiresAt > nowMs) return cached.map
  }
  const map = new Map<string, EditionRow>()
  const PAGE = 1000
  let complete = true
  try {
    for (let from = 0; from < 60_000; from += PAGE) {
      const { data, error } = await boundedRead((supabaseAdmin as any)
        .from("editions")
        .select("external_id, collection_id, player_name, set_name, set_id_onchain, play_id_onchain, badges")
        .eq("collection_id", collectionId)
        .order("external_id", { ascending: true })
        .range(from, from + PAGE - 1), "api/market/editions")
      if (error) {
        console.log("[/api/market] editions lookup error: " + error.message)
        complete = false
        break
      }
      const rows = (data ?? []) as EditionRow[]
      for (const r of rows) {
        const k = normJoinKey(r.player_name, r.set_name)
        if (!k) continue
        // Keep the most-resolved row when collisions happen — prefer the one
        // with both onchain ids populated.
        const existing = map.get(k)
        const incomingOnchain = r.set_id_onchain != null && r.play_id_onchain != null
        const existingOnchain = existing && existing.set_id_onchain != null && existing.play_id_onchain != null
        if (!existing || (incomingOnchain && !existingOnchain)) map.set(k, r)
      }
      if (rows.length < PAGE) break
    }
  } catch (err) {
    console.log("[/api/market] editions lookup threw: " + (err instanceof Error ? err.message : String(err)))
    complete = false
  }
  if (EDITION_LOOKUP_MEMO && complete) {
    editionLookupCache.set(collectionId, { expiresAt: nowMs + EDITION_LOOKUP_TTL_MS, map })
  }
  return map
}


// ── Modern listings helper (Phase 3.5, 2026-05-26) ──────────────────────────
// The legacy `cached_listings` table the route below reads from is post-Flowty-
// teardown dead for TS (0 rows) and stale for AllDay (~2 weeks). Modern data
// lives in `badge_editions` (TS) and `cached_listings_v2` (AllDay/Golazos/UFC).
// This helper dispatches to the same sniper RPCs the /api/sniper-feed route
// uses and emits rows in the legacy cached_listings response shape so the
// downstream clamp / discount / sort / paginate logic stays untouched.

const TS_COLLECTION_ID_FOR_DISPATCH = "95f28a17-224a-4025-96ad-adf8a4c63bfd"
const ALLDAY_COLLECTION_ID_FOR_DISPATCH = "dee28451-5d62-409e-a1ad-a83f763ac070"
const PINNACLE_COLLECTION_ID_FOR_DISPATCH = "7dd9dd11-e8b6-45c4-ac99-71331f959714"

// Pinnacle Market source (edition-level, 2026-07-18). Trevor's Market=edition /
// Sniper=serial split: Market shows ONE row per Pinnacle render (= edition) with
// its aggregate market, not individual listed pins. `pinnacle_catalog` is the
// canonical render-grain table and already carries a fresh, direct-chain
// (studio-platform-gql) `floor_ask` per render plus render-keyed FMV — a far more
// complete edition-grain source (~2,095 priced renders) than the live-Flowty
// sniper feed (capped ~96 listed NFTs). We read it directly and reshape into the
// legacy cached_listings row shape so the downstream clamp / discount / sort /
// paginate pipeline stays untouched. editionKey = render_id (the
// /disney-pinnacle/edition/<render_id> route redirects to /pinnacle/moment/<id>).
async function fetchPinnacleModernListings(
  collectionId: string,
  filters: { tier: string; maxPrice: number; sortBy: string },
): Promise<any[]> {
  try {
    let q = (supabaseAdmin as any)
      .from("pinnacle_catalog")
      .select("render_id, character_name, set_name, series_name, variant, total_minted, floor_ask, fmv_usd, fmv_confidence, thumbnail_url, floor_ask_updated_at")
      .not("floor_ask", "is", null)
      .gt("floor_ask", 0)
      // Only surface renders whose floor is currently maintained — a stale floor
      // whose listing has since been pulled shouldn't render as a live market row.
      .gte("floor_ask_updated_at", new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString())
    if (filters.maxPrice > 0) q = q.lte("floor_ask", filters.maxPrice)
    // PostgREST hard-caps reads at 1,000 rows, so order the fetch by the SAME
    // dimension the UI sort leads with — otherwise a fixed cheapest-first window
    // would hide the expensive renders under "Price ↓" / "FMV ↓". Final ordering
    // is still applied authoritatively in-memory downstream.
    const s = filters.sortBy
    if (s === "price_desc") q = q.order("floor_ask", { ascending: false, nullsFirst: false })
    else if (s === "fmv_desc") q = q.order("fmv_usd", { ascending: false, nullsFirst: false })
    else if (s === "fmv_asc") q = q.order("fmv_usd", { ascending: true, nullsFirst: false })
    else if (s === "recent" || s === "listed_desc") q = q.order("floor_ask_updated_at", { ascending: false, nullsFirst: false })
    else q = q.order("floor_ask", { ascending: true, nullsFirst: false }) // price_asc + discount (computed downstream)
    q = q.limit(1000)

    const { data, error } = await q
    if (error) {
      console.log("[/api/market] pinnacle catalog fetch err:", error.message)
      return []
    }
    return (data ?? []).map((r: any) => ({
      id: `pinnacle:${r.render_id}`,
      flow_id: null,                 // edition-grain row — no single on-chain moment
      moment_id: null,
      edition_key: r.render_id,      // canonical Pinnacle edition key
      player_name: r.character_name ?? null,
      team_name: null,
      set_name: r.set_name != null ? String(r.set_name).trim() : null,
      series_name: r.series_name ?? null,
      tier: r.variant ?? null,       // Pinnacle variant type (Standard / Colored Enamel / …)
      serial_number: null,
      circulation_count: r.total_minted != null ? Number(r.total_minted) : null,
      ask_price: r.floor_ask != null ? Number(r.floor_ask) : null,
      fmv: r.fmv_usd != null ? Number(r.fmv_usd) : null,
      adjusted_fmv: r.fmv_usd != null ? Number(r.fmv_usd) : null,
      discount: null,                // recomputed downstream from floor vs fmv
      confidence: r.fmv_confidence ?? null,
      source: "pinnacle",
      buy_url: null,
      thumbnail_url: r.thumbnail_url ?? null,
      badge_slugs: null,             // Pinnacle has no edition-wide badges
      listed_count: null,            // catalog floor is a floor, not a live-count
      listing_resource_id: null,
      storefront_address: null,
      is_locked: false,
      raw_data: null,
      listed_at: r.floor_ask_updated_at ?? null,
      cached_at: r.floor_ask_updated_at ?? null,
      collection_id: collectionId,
    }))
  } catch (err) {
    console.log("[/api/market] pinnacle catalog fetch threw:", err instanceof Error ? err.message : String(err))
    return []
  }
}

// AllDay Market source (edition-level, 2026-07-18). Same Market=edition split:
// one row per AllDay edition with an active listing, carrying floor ask, live
// listed-count, edition-wide badges, and render-keyed FMV. Backed by the
// service-role-only get_allday_market_editions RPC (aggregates 80k+ active
// cached_listings_v2 rows in SQL — grouping the 500-capped per-listing feed
// in-route would miss floors for ~90% of editions). editionKey = external_id
// (the canonical wmc edition_key shape for AllDay).
async function fetchAllDayMarketEditions(
  filters: { tier: string; team: string; maxPrice: number; sortBy: string; limit: number },
): Promise<any[]> {
  let rpcSort: string
  if (filters.sortBy === "recent" || filters.sortBy === "listed_desc") rpcSort = "listed_desc"
  else if (filters.sortBy.startsWith("price")) rpcSort = filters.sortBy
  else if (filters.sortBy === "fmv_desc") rpcSort = "fmv_desc"
  else if (filters.sortBy === "discount_desc") rpcSort = "discount_desc"
  else rpcSort = "listed_desc"

  const { data, error } = await boundedRead((supabaseAdmin as any).rpc("get_allday_market_editions", {
    p_min_discount: 0,
    p_max_price: filters.maxPrice > 0 ? filters.maxPrice : 0,
    p_rarity: filters.tier && filters.tier !== "all" ? filters.tier : "all",
    p_team: filters.team && filters.team !== "all" ? filters.team : "all",
    p_sort_by: rpcSort,
    p_limit: Math.max(filters.limit, 500),
  }), "api/market/get_allday_market_editions")
  if (error) {
    console.log("[/api/market] allday editions fetch err:", error.message)
    return []
  }
  return (data ?? []).map((r: any) => ({
    id: `allday-ed:${r.external_id ?? r.edition_id}`,
    flow_id: null,                 // edition-grain — no single moment / per-serial listing
    moment_id: null,
    edition_key: r.external_id ?? null,
    player_name: r.player_name ?? null,
    team_name: r.team_name ?? null,
    set_name: r.set_name ?? null,
    series_name: r.series_name ?? null,
    tier: r.tier ? String(r.tier).replace("MOMENT_TIER_", "") : null,
    serial_number: null,
    circulation_count: r.circulation_count != null ? Number(r.circulation_count) : null,
    ask_price: r.floor_ask != null ? Number(r.floor_ask) : null,
    fmv: r.fmv_usd != null ? Number(r.fmv_usd) : null,
    adjusted_fmv: r.fmv_usd != null ? Number(r.fmv_usd) : null,
    discount: r.discount_pct != null ? Number(r.discount_pct) : null,
    confidence: r.confidence ?? null,
    source: "allday",
    buy_url: null,
    thumbnail_url: r.thumbnail_url ?? null,
    badge_slugs: Array.isArray(r.badges) ? r.badges : null,   // edition-wide badges from the RPC
    listed_count: r.listed_count != null ? Number(r.listed_count) : null,
    listing_resource_id: null,
    storefront_address: null,
    is_locked: false,
    raw_data: null,
    listed_at: r.last_listed_at ?? null,
    cached_at: r.last_listed_at ?? null,
    collection_id: ALLDAY_COLLECTION_ID_FOR_DISPATCH,
  }))
}

async function fetchModernListings(
  collectionId: string,
  filters: { tier: string; team: string; maxPrice: number; minDiscount: number; sortBy: string; limit: number }
): Promise<any[] | null> {
  if (collectionId === PINNACLE_COLLECTION_ID_FOR_DISPATCH) {
    return fetchPinnacleModernListings(collectionId, { tier: filters.tier, maxPrice: filters.maxPrice, sortBy: filters.sortBy })
  }
  // AllDay Market is edition-level (Trevor, 2026-07-18): one row per edition via
  // get_allday_market_editions (SQL aggregate over 80k+ active listings), NOT the
  // per-listing get_allday_market_listings feed.
  if (collectionId === ALLDAY_COLLECTION_ID_FOR_DISPATCH) {
    return fetchAllDayMarketEditions({
      tier: filters.tier, team: filters.team, maxPrice: filters.maxPrice, sortBy: filters.sortBy, limit: filters.limit,
    })
  }
  let rpcName: string | null = null
  // TS continues to use the FMV-required sniper RPC: its data source is
  // badge_editions, one row per edition (already edition-grain), which only has
  // rows with low_ask + a matching FMV snapshot, so gating on FMV drops nothing.
  if (collectionId === TS_COLLECTION_ID_FOR_DISPATCH) rpcName = "get_topshot_sniper_deals"
  if (!rpcName) return null

  // Map Market's SortKey to a value the dispatched RPC understands. The sort
  // vocabulary mirrors /api/sniper-feed: "price_asc", "price_desc",
  // "fmv_desc", "discount_desc", "listed_desc". The AllDay market RPC defaults
  // to "listed_desc"; Market's "recent" default maps onto it. price + fmv +
  // discount pass through; everything else falls back to listed_desc.
  let rpcSort: string
  if (filters.sortBy === "recent" || filters.sortBy === "listed_desc") rpcSort = "listed_desc"
  else if (filters.sortBy.startsWith("price")) rpcSort = filters.sortBy
  else if (filters.sortBy === "fmv_desc") rpcSort = "fmv_desc"
  else if (filters.sortBy === "discount_desc") rpcSort = "discount_desc"
  else rpcSort = "listed_desc"

  const { data, error } = await boundedRead((supabaseAdmin as any).rpc(rpcName, {
    p_min_discount: 0, // Market should NOT pre-filter by discount; that filter is applied later in-app
    p_max_price: filters.maxPrice > 0 ? filters.maxPrice : 0,
    p_rarity: filters.tier && filters.tier !== "all" ? filters.tier : "all",
    p_team: filters.team && filters.team !== "all" ? filters.team : "all",
    p_sort_by: rpcSort,
    p_limit: Math.max(filters.limit, 500), // pull enough so downstream pagination has headroom
  }), `api/market/${rpcName}`)
  if (error) {
    console.log(`[/api/market] modern fetch err (${rpcName}):`, error.message)
    return []
  }

  // Reshape sniper RPC rows into the cached_listings field shape the rest of
  // the handler expects.
  return (data ?? []).map((r: any) => ({
    id: r.listing_resource_id ?? `${collectionId}:${r.moment_id ?? r.flow_id ?? Math.random()}`,
    flow_id: r.flow_id ?? null,
    moment_id: r.moment_id ?? null,
    player_name: r.player_name ?? null,
    team_name: r.team_name ?? null,
    set_name: r.set_name ?? null,
    series_name: r.series_name ?? null,
    // Strip the AllDay GQL MOMENT_TIER_ prefix so downstream TIER_CEILING
    // lookups + UI tier-filter behavior match the canonical short form
    // ("COMMON" / "RARE" / "LEGENDARY" / "ULTIMATE").
    tier: r.tier ? String(r.tier).replace("MOMENT_TIER_", "") : null,
    subedition_name: r.subedition_name ?? null,   // TS parallel printing name (Hexwave/Jukebox/…)
    serial_number: r.serial_number ?? null,
    circulation_count: r.circulation_count ?? null,
    ask_price: r.ask_price != null ? Number(r.ask_price) : null,
    fmv: r.fmv_usd != null ? Number(r.fmv_usd) : null,
    adjusted_fmv: r.fmv_usd != null ? Number(r.fmv_usd) : null,
    discount: r.discount_pct != null ? Number(r.discount_pct) : null,
    confidence: r.confidence ?? null,
    source: r.source ?? null,
    buy_url: r.buy_url ?? null,
    thumbnail_url: r.thumbnail_url ?? null,
    badge_slugs: null,
    listing_resource_id: r.listing_resource_id ?? null,
    storefront_address: null,
    is_locked: false,
    raw_data: null,
    listed_at: r.listed_at ?? null,
    cached_at: r.listed_at ?? null,
    collection_id: collectionId,
  }))
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams

  const collectionId = sp.get("collectionId") || sp.get("collection_id") || ""
  if (!collectionId) {
    return NextResponse.json(
      { error: "collectionId is required" },
      { status: 400 }
    )
  }

  // ── Filters ─────────────────────────────────────────────────────────────
  const tierRaw = sp.get("tier") || ""
  const tiers = tierRaw
    ? tierRaw.split(",").map(t => t.trim().toUpperCase()).filter(Boolean)
    : []

  const minPrice = parseFloat(sp.get("minPrice") || "")
  const maxPrice = parseFloat(sp.get("maxPrice") || "")
  const minDiscount = parseFloat(sp.get("minDiscount") || "")
  const maxDiscount = parseFloat(sp.get("maxDiscount") || "")
  const player = (sp.get("player") || "").trim()
  const setRaw = sp.get("set") || ""
  const sets = setRaw
    ? setRaw.split(",").map(s => s.trim()).filter(Boolean)
    : []
  const seriesRaw = sp.get("series") || ""
  const seriesList = seriesRaw
    ? seriesRaw.split(",").map(s => s.trim()).filter(Boolean)
    : []
  const teamRaw = sp.get("team") || ""
  const teams = teamRaw
    ? teamRaw.split(",").map(t => t.trim()).filter(Boolean)
    : []
  const badgeRaw = sp.get("badges") || ""
  const badges = badgeRaw
    ? badgeRaw.split(",").map(b => b.trim()).filter(Boolean)
    : []
  const hasBadges = sp.get("hasBadges") === "true" || badges.length > 0
  const specialSerials = sp.get("specialSerials") === "true"
  const parallel = (sp.get("parallel") || "").trim()

  // ── Pagination + sort ──────────────────────────────────────────────────
  const rawLimit = parseInt(sp.get("limit") || `${DEFAULT_LIMIT}`, 10)
  const limit = Math.max(1, Math.min(MAX_LIMIT, Number.isFinite(rawLimit) ? rawLimit : DEFAULT_LIMIT))
  const rawPage = parseInt(sp.get("page") || "1", 10)
  const page = Math.max(1, Number.isFinite(rawPage) ? rawPage : 1)
  const offset = (page - 1) * limit

  // Default cheapest-first (Trevor, 2026-07-18) — Market is the browse surface;
  // the client sends an explicit sort, so this only governs direct/no-sort calls.
  const sortRaw = (sp.get("sort") || "price_asc") as SortKey
  const sort: SortKey = ALLOWED_SORTS.has(sortRaw) ? sortRaw : "price_asc"

  try {
    // P1a display guard — Top Shot only. Clamps fake discounts (ask below an
    // FMV that exceeds the edition's own 90d max sale) and flags thin-data FMV.
    const isTopShotColl = collectionId === TS_COLLECTION_ID
    const fmvGuard: FmvGuardMap = isTopShotColl
      ? await loadTopshotFmvGuard(supabaseAdmin as any)
      : new Map()

    // Modern-source dispatch (Phase 3.5). TS + AllDay come from sniper RPCs
    // that read badge_editions / cached_listings_v2 respectively. Other
    // collections fall through to the legacy cached_listings query below.
    const modernRows = await fetchModernListings(collectionId, {
      tier: tiers[0] ?? "all",
      team: teams[0] ?? "all",
      maxPrice: Number.isFinite(maxPrice) ? maxPrice : 0,
      minDiscount: Number.isFinite(minDiscount) ? minDiscount : 0,
      sortBy: sort,
      limit,
    })
    // Fall through to the legacy cached_listings query when modern returns
    // empty. The sniper RPCs inner-join FMV, so collections with sparse FMV
    // (notably AllDay's ~341 priced rows vs ~34k v2 listings) come back 0;
    // the legacy table is stale-but-non-empty for those cases.
    if (modernRows !== null && modernRows.length === 0) {
      console.log(`[/api/market] modern returned 0 rows for ${collectionId} — falling through to cached_listings`)
    }
    if (modernRows !== null && modernRows.length > 0) {
      // Reuse the existing edition-lookup + clamp + discount + sort + paginate
      // pipeline by stuffing modernRows into the same `data` variable the
      // downstream code consumes. The DB query is short-circuited.
      const data = modernRows
      const count = modernRows.length
      const editionLookup = await loadEditionLookup(collectionId)

      const clamped = (data ?? []).filter((r: any) => {
        const tier = typeof r.tier === "string" ? r.tier.toUpperCase() : null
        const ceiling = tier ? TIER_CEILING[tier] : null
        if (ceiling != null && Number(r.ask_price) >= ceiling) return false
        return true
      })

      const isTopShot = collectionId === TS_COLLECTION_ID

      const enriched = clamped.map((r: any) => {
        const ask = r.ask_price != null ? Number(r.ask_price) : null
        const rawFmv = r.fmv != null ? Number(r.fmv) : null
        const lookupKey = normJoinKey(r.player_name, r.set_name)
        const ed = lookupKey ? editionLookup.get(lookupKey) : null
        // Prefer the row's own edition key when the source carries one (AllDay
        // editions RPC → external_id; Pinnacle catalog → render_id); otherwise
        // derive it from the editions-table lookup (TS on-chain integer form).
        let editionKey: string | null = r.edition_key ?? null
        if (!editionKey && ed) {
          if (isTopShot && ed.set_id_onchain != null && ed.play_id_onchain != null) {
            editionKey = `${ed.set_id_onchain}:${ed.play_id_onchain}`
          } else if (!isTopShot && ed.external_id) {
            editionKey = ed.external_id
          } else if (ed.external_id && /^\d+:\d+$/.test(ed.external_id)) {
            editionKey = ed.external_id
          }
        }
        // P1a: clamp FMV to the 90d max sale when it overshoots, then compute
        // the discount off the honest figure so no fake bargain surfaces.
        const g = isTopShot
          ? guardTopshotFmv(fmvGuard, r.moment_id ?? editionKey, rawFmv)
          : { effectiveFmv: rawFmv ?? 0, lowConfidenceFmv: false }
        const fmv = rawFmv == null ? null : g.effectiveFmv
        const discount = computeDiscount(ask, fmv)
        // Edition-wide badges: prefer the row's own (AllDay editions RPC), else
        // the editions-table lookup (TS). Market never shows special-serial badges.
        const rowBadges = Array.isArray(r.badge_slugs) ? r.badge_slugs : []
        const editionBadges = ed && Array.isArray(ed.badges) ? ed.badges : []
        const badgeSlugs = rowBadges.length > 0 ? rowBadges : editionBadges
        const listedCount = r.listed_count != null ? Number(r.listed_count) : null
        const serial = r.serial_number != null ? Number(r.serial_number) : null
        const circ = r.circulation_count != null ? Number(r.circulation_count) : null
        const isSpecialSerial =
          (serial != null && serial === 1) ||
          (serial != null && circ != null && circ > 0 && serial === circ)
        return {
          id: r.id,
          flowId: r.flow_id,
          momentId: r.moment_id,
          playerName: r.player_name,
          teamName: r.team_name,
          setName: r.set_name,
          seriesName: r.series_name,
          tier: r.tier,
          // TopShot parallel/subedition printing name (Hexwave, Jukebox, …) from
          // editions.subedition_name via get_topshot_sniper_deals; null for base
          // editions and non-TS collections (no parallel concept).
          parallel: r.subedition_name ?? null,
          serialNumber: serial,
          circulationCount: circ,
          listedCount,
          askPrice: ask,
          fmv,
          discount,
          // Treat ASK_ONLY FMV as thin data: its "FMV" is derived from an ask
          // (low_ask×0.9), never from sales, so ANY discount vs it is ask-vs-ask,
          // not a real deal (a stale $700 ask → $385 FMV makes a fresh $12
          // listing render "−97%"). Flagging it flows through the same "⚠ thin
          // data" chip + discount-sort demotion the P2.5 guard already applies.
          lowConfidenceFmv: g.lowConfidenceFmv || String(r.confidence ?? "").toUpperCase() === "ASK_ONLY",
          confidence: r.confidence,
          source: r.source,
          buyUrl: r.buy_url,
          thumbnailUrl: r.thumbnail_url,
          badgeSlugs,
          editionKey,
          isSpecialSerial,
          listingResourceId: r.listing_resource_id,
          storefrontAddress: r.storefront_address,
          isLocked: r.is_locked,
          listedAt: r.listed_at,
          cachedAt: r.cached_at,
          collectionId: r.collection_id,
        }
      })

      const hasMinDiscount = Number.isFinite(minDiscount)
      const hasMaxDiscount = Number.isFinite(maxDiscount)
      let postFiltered = enriched
      if (hasMinDiscount || hasMaxDiscount) {
        postFiltered = postFiltered.filter(r => {
          if (r.discount == null) return false
          if (hasMinDiscount && r.discount < minDiscount) return false
          if (hasMaxDiscount && r.discount > maxDiscount) return false
          return true
        })
      }
      if (specialSerials) postFiltered = postFiltered.filter(r => r.isSpecialSerial)
      // Authoritatively order the modern feed in-memory so the shown order ALWAYS
      // matches the selected sort — the upstream sniper RPCs don't reliably honor
      // every sort value (e.g. get_topshot_sniper_deals silently ignores
      // "listed_desc" and falls back to discount), which used to make the label lie.
      // discount sort also demotes thin-data (lowConfidenceFmv) below verified rows
      // so a real 30%-off deal outranks a fake 91%-off thin common.
      const listedTs = (v: string | null | undefined) => (v ? Date.parse(v) || 0 : 0)
      switch (sort) {
        case "price_asc":
          postFiltered.sort((a, b) => (a.askPrice ?? Infinity) - (b.askPrice ?? Infinity)); break
        case "price_desc":
          postFiltered.sort((a, b) => (b.askPrice ?? -Infinity) - (a.askPrice ?? -Infinity)); break
        case "fmv_asc":
          postFiltered.sort((a, b) => (a.fmv ?? Infinity) - (b.fmv ?? Infinity)); break
        case "fmv_desc":
          postFiltered.sort((a, b) => (b.fmv ?? -Infinity) - (a.fmv ?? -Infinity)); break
        case "discount_desc":
          postFiltered.sort((a, b) => Number(!!a.lowConfidenceFmv) - Number(!!b.lowConfidenceFmv) || (b.discount ?? -Infinity) - (a.discount ?? -Infinity)); break
        case "discount_asc":
          postFiltered.sort((a, b) => Number(!!a.lowConfidenceFmv) - Number(!!b.lowConfidenceFmv) || (a.discount ?? Infinity) - (b.discount ?? Infinity)); break
        case "recent":
        default:
          postFiltered.sort((a, b) => listedTs(b.listedAt) - listedTs(a.listedAt)); break
      }

      // Unlike the legacy branch below, `count` here is just modernRows.length —
      // the sniper RPC is already called with `limit`, so this branch only ever
      // sees ONE page and can never observe rows beyond it. `total` is therefore
      // exact for what was fetched but is a floor whenever the RPC returned a
      // full page (there may be more upstream). Flagged rather than implied.
      const total = postFiltered.length
      const paged = postFiltered.slice(offset, offset + limit)
      const hasMore = offset + limit < total
      const modernPageFull = (data?.length ?? 0) >= limit

      return NextResponse.json({
        listings: paged,
        pagination: {
          total,
          page,
          limit,
          hasMore,
          totalIsExact: !modernPageFull,
          matchedBeforeFilters: null,
        },
        clamp: { applied: true, ceilings: TIER_CEILING },
        diagnostics: { rawCount: count, postClampCount: clamped.length, postFilterCount: total, source: "modern", windowTruncated: modernPageFull },
      }, {
        headers: { "Cache-Control": "public, s-maxage=90, stale-while-revalidate=60" },
      })
    }

    // Primary query — pull up to MAX_LIMIT rows for this collection with
    // filters applied. We then compute discount in app code, apply the
    // discount filter + discount sort, and slice for pagination.
    let q = supabaseAdmin
      .from("cached_listings")
      .select("*", { count: "exact" })
      .eq("collection_id", collectionId)
      .not("ask_price", "is", null)
      .lte("ask_price", ABSOLUTE_CEILING)

    if (tiers.length > 0) q = q.in("tier", tiers)
    if (Number.isFinite(minPrice) && minPrice > 0) q = q.gte("ask_price", minPrice)
    if (Number.isFinite(maxPrice) && maxPrice > 0) q = q.lte("ask_price", maxPrice)
    if (player) q = q.ilike("player_name", `%${player}%`)
    if (sets.length > 0) q = q.in("set_name", sets)
    if (seriesList.length > 0) q = q.in("series_name", seriesList)
    if (teams.length > 0) q = q.in("team_name", teams)
    if (hasBadges) q = q.not("badge_slugs", "is", null)
    if (badges.length > 0) q = q.overlaps("badge_slugs", badges)
    if (parallel) q = q.ilike("raw_data->>parallel", `%${parallel}%`)

    // DB-level sort only for columns PostgREST can order on directly.
    // Discount sort happens in memory after discount + clamp filter.
    const nullsLast = { nullsFirst: false } as const
    switch (sort) {
      case "price_asc":  q = q.order("ask_price", { ascending: true,  ...nullsLast }); break
      case "price_desc": q = q.order("ask_price", { ascending: false, ...nullsLast }); break
      case "fmv_asc":    q = q.order("fmv",       { ascending: true,  ...nullsLast }); break
      case "fmv_desc":   q = q.order("fmv",       { ascending: false, ...nullsLast }); break
      case "discount_asc":
      case "discount_desc":
      case "recent":
      default:
        q = q.order("listed_at", { ascending: false, ...nullsLast }); break
    }

    // Fetch a larger window when discount sort is active so in-memory sort
    // gives a stable ordering across pagination.
    const fetchLimit = sort.startsWith("discount") ? MAX_LIMIT : Math.min(MAX_LIMIT, offset + limit + 100)
    q = q.range(0, fetchLimit - 1)

    // Run editions lookup in parallel with the main query.
    const [{ data, error, count }, editionLookup] = await Promise.all([
      q,
      loadEditionLookup(collectionId),
    ])

    if (error) {
      console.log("[/api/market] query error:", error.message)
      return apiErrorResponse(error, "api/market")
    }

    // ── Tier-based outlier clamp + edition enrichment + discount ─────────
    const clamped = (data ?? []).filter((r: any) => {
      const tier = typeof r.tier === "string" ? r.tier.toUpperCase() : null
      const ceiling = tier ? TIER_CEILING[tier] : null
      if (ceiling != null && Number(r.ask_price) >= ceiling) return false
      return true
    })

    const isTopShot = collectionId === TS_COLLECTION_ID

    const enriched = clamped.map((r: any) => {
      const ask = r.ask_price != null ? Number(r.ask_price) : null
      const rawFmv = r.fmv != null ? Number(r.fmv) : null
      const lookupKey = normJoinKey(r.player_name, r.set_name)
      const ed = lookupKey ? editionLookup.get(lookupKey) : null
      // editionKey: TS uses on-chain integers (matches wmc); others use the
      // editions.external_id slug (also matches wmc for those collections).
      let editionKey: string | null = null
      if (ed) {
        if (isTopShot && ed.set_id_onchain != null && ed.play_id_onchain != null) {
          editionKey = `${ed.set_id_onchain}:${ed.play_id_onchain}`
        } else if (!isTopShot && ed.external_id) {
          editionKey = ed.external_id
        } else if (ed.external_id && /^\d+:\d+$/.test(ed.external_id)) {
          editionKey = ed.external_id
        }
      }
      // P1a: clamp FMV to the 90d max sale when it overshoots (see modern path).
      const g = isTopShot
        ? guardTopshotFmv(fmvGuard, r.moment_id ?? editionKey, rawFmv)
        : { effectiveFmv: rawFmv ?? 0, lowConfidenceFmv: false }
      const fmv = rawFmv == null ? null : g.effectiveFmv
      const discount = computeDiscount(ask, fmv)
      // Fall back to editions.badges if cached_listings.badge_slugs is empty.
      const cachedBadges = Array.isArray(r.badge_slugs) ? r.badge_slugs : []
      const editionBadges = ed && Array.isArray(ed.badges) ? ed.badges : []
      const badgeSlugs = cachedBadges.length > 0 ? cachedBadges : editionBadges
      const serial = r.serial_number != null ? Number(r.serial_number) : null
      const circ = r.circulation_count != null ? Number(r.circulation_count) : null
      const isSpecialSerial =
        (serial != null && serial === 1) ||
        (serial != null && circ != null && circ > 0 && serial === circ)
      return {
        id: r.id,
        flowId: r.flow_id,
        momentId: r.moment_id,
        playerName: r.player_name,
        teamName: r.team_name,
        setName: r.set_name,
        seriesName: r.series_name,
        tier: r.tier,
        parallel: r.subedition_name ?? null,
        serialNumber: serial,
        circulationCount: circ,
        listedCount: null,
        askPrice: ask,
        fmv,
        discount,
        // ASK_ONLY FMV is ask-derived (no sales anchor) → thin data; see the
        // modern-path note above. Suppresses fake ask-vs-ask discounts.
        lowConfidenceFmv: g.lowConfidenceFmv || String(r.confidence ?? "").toUpperCase() === "ASK_ONLY",
        confidence: r.confidence,
        source: r.source,
        buyUrl: r.buy_url,
        thumbnailUrl: r.thumbnail_url,
        badgeSlugs,
        editionKey,
        isSpecialSerial,
        listingResourceId: r.listing_resource_id,
        storefrontAddress: r.storefront_address,
        isLocked: r.is_locked,
        listedAt: r.listed_at,
        cachedAt: r.cached_at,
        collectionId: r.collection_id,
      }
    })

    // Market is edition-level (Trevor, 2026-07-18): collapse the per-listing
    // cached_listings rows (Golazos / UFC) into one row per edition before
    // filtering/sorting/paginating. TS/AllDay/Pinnacle aggregate at their source.
    // Discount filter happens after computation.
    const hasMinDiscount = Number.isFinite(minDiscount)
    const hasMaxDiscount = Number.isFinite(maxDiscount)
    let postFiltered = collapseToEditions(enriched)
    if (hasMinDiscount || hasMaxDiscount) {
      postFiltered = postFiltered.filter(r => {
        if (r.discount == null) return false
        if (hasMinDiscount && r.discount < minDiscount) return false
        if (hasMaxDiscount && r.discount > maxDiscount) return false
        return true
      })
    }

    // Special-serials filter (server-side because the hint columns are
    // already on the row). Defined as serial == 1 OR serial == circulation_count.
    // Runs AFTER collapseToEditions, so it reads the representative (floor-ask)
    // listing's flag that the collapse now carries through — see the note there.
    if (specialSerials) {
      postFiltered = postFiltered.filter(r => r.isSpecialSerial)
    }

    // Apply discount sort in memory. P2.5 — demote thin-data (lowConfidenceFmv)
    // listings below verified ones so fake thin-FMV discounts don't lead.
    if (sort === "discount_desc") {
      postFiltered.sort((a, b) =>
        Number(!!a.lowConfidenceFmv) - Number(!!b.lowConfidenceFmv) || (b.discount ?? -Infinity) - (a.discount ?? -Infinity))
    } else if (sort === "discount_asc") {
      postFiltered.sort((a, b) =>
        Number(!!a.lowConfidenceFmv) - Number(!!b.lowConfidenceFmv) || (a.discount ?? Infinity) - (b.discount ?? Infinity))
    }

    // ── Honest total (fixed 2026-08-01) ────────────────────────────────────
    // This route asks PostgREST for { count: "exact" } — the true number of
    // rows matching the DB-level filters, uncapped — and then threw it away,
    // reporting `postFiltered.length` as `total`. That is NOT a total:
    //   * the fetch window is bounded by `fetchLimit`, which for every
    //     non-discount sort is only `offset + limit + 100`, so `total` was
    //     effectively the WINDOW SIZE, and
    //   * for discount sorts it is capped at MAX_LIMIT (1000).
    // Once a collection had more matching rows than the window, `total` and
    // `hasMore` under-reported and the UI stopped paginating early.
    //
    // `count` alone is not the answer either: the clamp + discount + special-
    // serial filters run in app code, so they can drop rows `count` still
    // includes. So resolve the three cases explicitly and SAY which one it is
    // rather than emitting a silently-capped number:
    //   1. the window held every matching row  -> post-filter count is exact
    //   2. window truncated, but nothing was dropped in app -> count is exact
    //   3. window truncated AND rows were dropped in app -> report a FLOOR
    const fetchedCount = data?.length ?? 0
    const dbMatched = typeof count === "number" ? count : null
    const windowHeldEverything = dbMatched !== null && dbMatched <= fetchedCount
    const droppedInApp = fetchedCount - postFiltered.length

    let total: number
    let totalIsExact: boolean
    if (windowHeldEverything) {
      total = postFiltered.length
      totalIsExact = true
    } else if (dbMatched !== null && droppedInApp === 0) {
      total = dbMatched
      totalIsExact = true
    } else {
      total = postFiltered.length
      totalIsExact = false
    }

    const paged = postFiltered.slice(offset, offset + limit)
    const hasMore = offset + limit < total

    return NextResponse.json({
      listings: paged,
      pagination: {
        total,
        page,
        limit,
        hasMore,
        // false => `total` is a LOWER BOUND: the result set was truncated by the
        // fetch window AND in-app filters removed rows, so an exact count is not
        // knowable without fetching the whole collection. Consumers should render
        // it as "N+" rather than "N".
        totalIsExact,
        // Exact count of rows matching the DB-level filters, before the in-app
        // clamp / discount / special-serial filters. null if PostgREST omitted it.
        matchedBeforeFilters: dbMatched,
      },
      clamp: {
        applied: true,
        ceilings: TIER_CEILING,
      },
      // Diagnostic: count before clamp vs after, so the Market page can
      // show a muted "N listings filtered as outliers" line when relevant.
      diagnostics: {
        rawCount: count ?? (data?.length ?? 0),
        postClampCount: clamped.length,
        postFilterCount: postFiltered.length,
        fetchedCount,
        fetchLimit,
        windowTruncated: !windowHeldEverything,
      },
    }, {
      headers: {
        // Listing cache refreshes every few minutes — 90s CDN cache with
        // 60s SWR keeps page loads snappy without serving badly stale data.
        "Cache-Control": "public, s-maxage=90, stale-while-revalidate=60",
      },
    })
  } catch (err) {
    console.log("[/api/market] error:", err instanceof Error ? err.message : String(err))
    return apiErrorResponse(err, "market", "The market board isn't available right now.")
  }
}

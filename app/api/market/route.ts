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

export const dynamic = "force-dynamic"
export const maxDuration = 10

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

interface EditionRow {
  external_id: string | null
  collection_id: string
  player_name: string | null
  set_name: string | null
  set_id_onchain: number | null
  play_id_onchain: number | null
  badges: string[] | null
}

async function loadEditionLookup(collectionId: string): Promise<Map<string, EditionRow>> {
  // One query per request. cached_listings is small (~280 rows total across
  // all collections today), and the editions table is bounded too — joining
  // in-memory is faster than fanning out per-row PostgREST calls.
  const map = new Map<string, EditionRow>()
  try {
    const { data, error } = await (supabaseAdmin as any)
      .from("editions")
      .select("external_id, collection_id, player_name, set_name, set_id_onchain, play_id_onchain, badges")
      .eq("collection_id", collectionId)
      .limit(50_000)
    if (error) {
      console.log("[/api/market] editions lookup error: " + error.message)
      return map
    }
    for (const r of (data ?? []) as EditionRow[]) {
      const k = normJoinKey(r.player_name, r.set_name)
      if (!k) continue
      // Keep the most-resolved row when collisions happen — prefer the one
      // with both onchain ids populated.
      const existing = map.get(k)
      const incomingOnchain = r.set_id_onchain != null && r.play_id_onchain != null
      const existingOnchain = existing && existing.set_id_onchain != null && existing.play_id_onchain != null
      if (!existing || (incomingOnchain && !existingOnchain)) map.set(k, r)
    }
  } catch (err) {
    console.log("[/api/market] editions lookup threw: " + (err instanceof Error ? err.message : String(err)))
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

async function fetchModernListings(
  collectionId: string,
  filters: { tier: string; team: string; maxPrice: number; minDiscount: number; sortBy: string; limit: number }
): Promise<any[] | null> {
  let rpcName: string | null = null
  if (collectionId === TS_COLLECTION_ID_FOR_DISPATCH) rpcName = "get_topshot_sniper_deals"
  else if (collectionId === ALLDAY_COLLECTION_ID_FOR_DISPATCH) rpcName = "get_allday_sniper_deals"
  if (!rpcName) return null

  const { data, error } = await (supabaseAdmin as any).rpc(rpcName, {
    p_min_discount: 0, // Market should NOT pre-filter by discount; that filter is applied later in-app
    p_max_price: filters.maxPrice > 0 ? filters.maxPrice : 0,
    p_rarity: filters.tier && filters.tier !== "all" ? filters.tier : "all",
    p_team: filters.team && filters.team !== "all" ? filters.team : "all",
    p_sort_by: filters.sortBy.startsWith("price") ? filters.sortBy : "discount_desc",
    p_limit: Math.max(filters.limit, 500), // pull enough so downstream pagination has headroom
  })
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
    tier: r.tier ?? null,
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

  const sortRaw = (sp.get("sort") || "recent") as SortKey
  const sort: SortKey = ALLOWED_SORTS.has(sortRaw) ? sortRaw : "recent"

  try {
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
    if (modernRows !== null) {
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
        const fmv = r.fmv != null ? Number(r.fmv) : null
        const discount = computeDiscount(ask, fmv)
        const lookupKey = normJoinKey(r.player_name, r.set_name)
        const ed = lookupKey ? editionLookup.get(lookupKey) : null
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
        const editionBadges = ed && Array.isArray(ed.badges) ? ed.badges : []
        const badgeSlugs = editionBadges
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
          serialNumber: serial,
          circulationCount: circ,
          askPrice: ask,
          fmv,
          discount,
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
      if (sort === "discount_desc") postFiltered.sort((a, b) => (b.discount ?? -Infinity) - (a.discount ?? -Infinity))
      else if (sort === "discount_asc") postFiltered.sort((a, b) => (a.discount ?? Infinity) - (b.discount ?? Infinity))

      const total = postFiltered.length
      const paged = postFiltered.slice(offset, offset + limit)
      const hasMore = offset + limit < total

      return NextResponse.json({
        listings: paged,
        pagination: { total, page, limit, hasMore },
        clamp: { applied: true, ceilings: TIER_CEILING },
        diagnostics: { rawCount: count, postClampCount: clamped.length, postFilterCount: total, source: "modern" },
      }, {
        headers: { "Cache-Control": "public, s-maxage=30, stale-while-revalidate=60" },
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
      return NextResponse.json({ error: error.message }, { status: 500 })
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
      const fmv = r.fmv != null ? Number(r.fmv) : null
      const discount = computeDiscount(ask, fmv)
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
        serialNumber: serial,
        circulationCount: circ,
        askPrice: ask,
        fmv,
        discount,
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

    // Discount filter happens after computation.
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

    // Special-serials filter (server-side because the hint columns are
    // already on the row). Defined as serial == 1 OR serial == circulation_count.
    if (specialSerials) {
      postFiltered = postFiltered.filter(r => r.isSpecialSerial)
    }

    // Apply discount sort in memory.
    if (sort === "discount_desc") {
      postFiltered.sort((a, b) => (b.discount ?? -Infinity) - (a.discount ?? -Infinity))
    } else if (sort === "discount_asc") {
      postFiltered.sort((a, b) => (a.discount ?? Infinity) - (b.discount ?? Infinity))
    }

    const total = postFiltered.length
    const paged = postFiltered.slice(offset, offset + limit)
    const hasMore = offset + limit < total

    return NextResponse.json({
      listings: paged,
      pagination: {
        total,
        page,
        limit,
        hasMore,
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
        postFilterCount: total,
      },
    }, {
      headers: {
        // Listing cache refreshes every few minutes — 30s CDN cache with
        // 60s SWR keeps page loads snappy without serving badly stale data.
        "Cache-Control": "public, s-maxage=30, stale-while-revalidate=60",
      },
    })
  } catch (err) {
    console.log("[/api/market] error:", err instanceof Error ? err.message : String(err))
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 }
    )
  }
}

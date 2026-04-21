// app/api/market/route.ts
//
// Phase 3 — Market browser API.
//
// Collection-aware listing feed pulled from cached_listings (which is already
// fully denormalized — player_name, team_name, set_name, tier, serial_number,
// ask_price, fmv, thumbnail_url, badge_slugs live on the row). Replaces the
// old NBA-only badge_editions version.
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
// Discount + fmv joins:
//   cached_listings has fmv on-row but confidence is NULL today (the ingester
//   doesn't populate it). For the Market browse shape that's fine — we compute
//   discount here and let the client render a LOW confidence chip when fmv is
//   null or missing. fmv_current is not joined — cached_listings.fmv is the
//   snapshot that was live when the listing was cached, which is what you
//   want in the marketplace view anyway.
//
// Pagination:
//   Server-side via range(). Max 1000 rows per query, default page size 50.
//   Response includes { total, page, hasMore } so the client doesn't have to
//   eat a 1000-row payload for UI-side paging.
//
// Sort:
//   price_asc / price_desc / discount_asc / discount_desc / fmv_asc / fmv_desc
//   / recent (listed_at desc, default). discount sorts fall back to in-memory
//   sort of the current page since PostgREST can't order by a cross-column
//   expression.

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"

export const dynamic = "force-dynamic"
export const maxDuration = 10

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
  const hasBadges = sp.get("hasBadges") === "true"
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
    if (hasBadges) q = q.not("badge_slugs", "is", null)
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

    const { data, error, count } = await q
    if (error) {
      console.log("[/api/market] query error:", error.message)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    // ── Tier-based outlier clamp + discount computation ──────────────────
    const clamped = (data ?? []).filter((r: any) => {
      const tier = typeof r.tier === "string" ? r.tier.toUpperCase() : null
      const ceiling = tier ? TIER_CEILING[tier] : null
      if (ceiling != null && Number(r.ask_price) >= ceiling) return false
      return true
    })

    const enriched = clamped.map((r: any) => {
      const ask = r.ask_price != null ? Number(r.ask_price) : null
      const fmv = r.fmv != null ? Number(r.fmv) : null
      const discount = computeDiscount(ask, fmv)
      return {
        id: r.id,
        flowId: r.flow_id,
        momentId: r.moment_id,
        playerName: r.player_name,
        teamName: r.team_name,
        setName: r.set_name,
        seriesName: r.series_name,
        tier: r.tier,
        serialNumber: r.serial_number,
        circulationCount: r.circulation_count,
        askPrice: ask,
        fmv,
        discount,
        confidence: r.confidence,
        source: r.source,
        buyUrl: r.buy_url,
        thumbnailUrl: r.thumbnail_url,
        badgeSlugs: Array.isArray(r.badge_slugs) ? r.badge_slugs : [],
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
    const discountFiltered = (hasMinDiscount || hasMaxDiscount)
      ? enriched.filter(r => {
          if (r.discount == null) return false
          if (hasMinDiscount && r.discount < minDiscount) return false
          if (hasMaxDiscount && r.discount > maxDiscount) return false
          return true
        })
      : enriched

    // Apply discount sort in memory.
    if (sort === "discount_desc") {
      discountFiltered.sort((a, b) => (b.discount ?? -Infinity) - (a.discount ?? -Infinity))
    } else if (sort === "discount_asc") {
      discountFiltered.sort((a, b) => (a.discount ?? Infinity) - (b.discount ?? Infinity))
    }

    const total = discountFiltered.length
    const paged = discountFiltered.slice(offset, offset + limit)
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

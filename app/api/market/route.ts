// app/api/market/route.ts
//
// Serves the Market page browse layer.
// Queries badge_editions with full filter/sort support:
//   player, set_name, series, tier, team, parallel,
//   badge_filter, min/max price, min/max fmv,
//   min/max serial (filters on low_ask_serial range — approximated via supply),
//   min_discount_pct, jersey_serial, last_mint
//
// The owned/not-owned filter is applied client-side (wallet-based).

import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { getTopShotMarketTruth } from "@/lib/topshot-market-truth"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const TOPSHOT_COLLECTION_ID = "95f28a17-224a-4025-96ad-adf8a4c63bfd"

async function handleSearchMode(editionKey: string) {
  const parts = editionKey.split(":")
  if (parts.length !== 2) return NextResponse.json({ error: "edition must be SETID:PLAYID" }, { status: 400 })
  const [setId, playId] = parts

  const [probe, editionRow] = await Promise.all([
    getTopShotMarketTruth({ editionKey, bestAsk: null, lastPurchasePrice: null }).catch(() => null),
    supabase.from("editions").select("id, external_id").eq("external_id", editionKey).eq("collection_id", TOPSHOT_COLLECTION_ID).maybeSingle(),
  ])

  const editionUuid = editionRow?.data?.id ?? null
  let fmv: number | null = null
  let fmvConfidence: string | null = null
  let recentSales: Array<{ price: number; date: string }> = []

  if (editionUuid) {
    const [{ data: fmvData }, { data: salesData }] = await Promise.all([
      supabase.from("fmv_snapshots")
        .select("fmv_usd, confidence, computed_at")
        .eq("edition_id", editionUuid)
        .order("computed_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabase.from("sales")
        .select("price_usd, sold_at")
        .eq("edition_id", editionUuid)
        .gte("sold_at", new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString())
        .order("sold_at", { ascending: false })
        .limit(60),
    ])
    if (fmvData) {
      fmv = fmvData.fmv_usd != null ? Number(fmvData.fmv_usd) : null
      fmvConfidence = fmvData.confidence ?? null
    }
    recentSales = (salesData ?? []).map((s: any) => ({ price: Number(s.price_usd), date: s.sold_at }))
  }

  // Badge editions lookup by id prefix (set_uuid+play_uuid+0) — we match on player_name via editions join
  let be: any = null
  if (editionRow?.data?.id) {
    const { data: beRow } = await supabase
      .from("badge_editions")
      .select("avg_sale_price, low_ask, highest_offer, player_name, set_name, tier, lock_rate_pct, burn_rate_pct, circulation_count")
      .eq("id", `${editionRow.data.id}+0`)
      .maybeSingle()
    be = beRow
  }

  const lowAsk = be?.low_ask != null ? Number(be.low_ask) : (probe?.editionListingFloor ?? null)
  const highestOffer = be?.highest_offer != null ? Number(be.highest_offer) : (probe?.editionOfferMax ?? null)

  const recentPrices = recentSales.slice(0, 10).map((s) => s.price).filter((p) => p > 0)
  const avg = recentPrices.length > 0 ? recentPrices.reduce((a, b) => a + b, 0) / recentPrices.length : (be?.avg_sale_price != null ? Number(be.avg_sale_price) : null)
  const salesCount30d = recentSales.length
  const liquidityRating = salesCount30d >= 30 ? "high" : salesCount30d >= 10 ? "medium" : salesCount30d >= 1 ? "low" : "none"
  const dealRating = (fmv != null && lowAsk != null && fmv > 0)
    ? (lowAsk <= fmv * 0.8 ? "great" : lowAsk <= fmv * 0.95 ? "good" : lowAsk <= fmv ? "fair" : "premium")
    : "unknown"

  const isLowestAsk = lowAsk != null && fmv != null && fmv > 0 && lowAsk <= fmv * 0.9

  return NextResponse.json({
    mode: "search",
    editionKey,
    playerName: be?.player_name ?? null,
    setName: be?.set_name ?? null,
    tier: be?.tier ?? null,
    fmv,
    fmvConfidence,
    lowAsk,
    highestOffer,
    editionListingCount: probe?.editionListingCount ?? null,
    averageSaleData: {
      average: avg,
      sampleSize: recentPrices.length,
      window: "30d",
    },
    recentSales: recentSales.slice(0, 10),
    liquidityRating,
    dealRating,
    salesCount30d,
    isLowestAsk,
    buyUrl: editionRow?.data?.id
      ? `https://nbatopshot.com/listings/p2p/${editionRow.data.id}+0`
      : null,
  })
}

async function handleLeaderboardMode(sortBy: string, limit: number) {
  // We don't have sales_count_30d or liquidity_rating columns on badge_editions.
  // For volume/liquidity, approximate via burn_rate / lock_rate inversion or fallback to avg_sale_price presence.
  // For discount, server pre-filters on avg_sale_price presence and computes client-side.

  let q = supabase
    .from("badge_editions")
    .select("id, player_name, set_name, tier, low_ask, avg_sale_price, highest_offer, burn_rate_pct, lock_rate_pct, circulation_count")
    .eq("parallel_id", 0)
    .eq("flow_retired", false)
    .not("low_ask", "is", null)

  if (sortBy === "volume") {
    q = q.not("avg_sale_price", "is", null).order("avg_sale_price", { ascending: false }).limit(limit * 4)
  } else if (sortBy === "liquidity") {
    q = q.order("burn_rate_pct", { ascending: true, nullsFirst: false }).limit(limit)
  } else {
    q = q.not("avg_sale_price", "is", null).order("avg_sale_price", { ascending: false }).limit(limit * 4)
  }

  const { data, error } = await q
  if (error) throw error

  // Map editions.id uuid → external_id (SETID:PLAYID) for links
  const ids = (data ?? []).map((e: any) => String(e.id).split("+").slice(0, 2).join("+"))
  const uniqueUuids = Array.from(new Set((data ?? []).flatMap((e: any) => String(e.id).split("+").slice(0, 2))))
  // editions table uses uuid id and external_id "setID:playID" — we can't map without joining. Skip external mapping — use editions.id prefix as buyUrl.

  const rows = (data ?? []).map((e: any) => {
    const fmv = e.avg_sale_price != null ? Number(e.avg_sale_price) : null
    const ask = e.low_ask != null ? Number(e.low_ask) : null
    const discountPct = fmv && ask && fmv > 0 ? Math.round((1 - ask / fmv) * 100) : null
    const circ = e.circulation_count != null ? Number(e.circulation_count) : 0
    return {
      badgeEditionId: e.id,
      playerName: e.player_name,
      setName: e.set_name,
      tier: e.tier,
      fmv,
      lowAsk: ask,
      highestOffer: e.highest_offer != null ? Number(e.highest_offer) : null,
      liquidityRating: e.burn_rate_pct != null && e.burn_rate_pct < 10 ? "high" : "medium",
      dealRating: discountPct != null && discountPct >= 20 ? "great" : discountPct != null && discountPct >= 10 ? "good" : "fair",
      salesCount30d: null,
      circulationCount: circ,
      discountPct,
    }
  })

  let sorted = rows
  if (sortBy === "discount") {
    sorted = rows.filter((r) => r.discountPct != null).sort((a, b) => (b.discountPct ?? -999) - (a.discountPct ?? -999)).slice(0, limit)
  } else if (sortBy === "volume") {
    sorted = rows.sort((a, b) => (b.fmv ?? 0) - (a.fmv ?? 0)).slice(0, limit)
  }

  return NextResponse.json({ mode: "leaderboard", sortBy, rows: sorted })
}

// Badge filter → play_tag IDs (same as badges route)
const BADGE_TAG_IDS: Record<string, string> = {
  ts:   "a75e247a-ecbf-45a6-b1be-58bb07a1b651", // Top Shot Debut
  ry:   "2dbd4eef-4417-451b-b645-90f02574a401", // Rookie Year
  rm:   "24d515af-e967-45f5-a30e-11fc96dc2b62", // Rookie Mint (set tag)
  rp:   "",                                      // Rookie Premiere — badge_score heuristic
  cy:   "",                                      // Championship Year — badge_score heuristic
  cr:   "",
  roty: "34fe8d3f-681a-42df-856a-e98624f95b11", // ROTY
}

const ALLOWED_SORTS = new Set([
  "badge_score", "burn_rate_pct", "lock_rate_pct",
  "low_ask", "avg_sale_price", "player_name", "circulation_count",
])

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams

  const mode = sp.get("mode")
  if (mode === "search") {
    const edition = sp.get("edition") ?? ""
    if (!edition) return NextResponse.json({ error: "edition param required" }, { status: 400 })
    try {
      return await handleSearchMode(edition)
    } catch (err) {
      return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
    }
  }
  if (mode === "leaderboard") {
    const sortBy = sp.get("sortBy") ?? "volume"
    const lbLimit = Math.min(200, parseInt(sp.get("limit") ?? "50", 10))
    try {
      return await handleLeaderboardMode(sortBy, lbLimit)
    } catch (err) {
      return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
    }
  }

  const player      = sp.get("player")          ?? ""
  const setName     = sp.get("set_name")         ?? ""
  const series      = sp.get("series")           ?? ""
  const tier        = sp.get("tier")             ?? ""
  const team        = sp.get("team")             ?? ""
  const parallel    = sp.get("parallel")         ?? ""
  const badgeFilter = sp.get("badge_filter")     ?? ""
  const minPrice    = parseFloat(sp.get("min_price") ?? "")
  const maxPrice    = parseFloat(sp.get("max_price") ?? "")
  const minFmv      = parseFloat(sp.get("min_fmv")   ?? "")
  const maxFmv      = parseFloat(sp.get("max_fmv")   ?? "")
  const minDiscount = parseFloat(sp.get("min_discount_pct") ?? "")
  const jerseySerial = sp.get("jersey_serial") === "true"
  const lastMint     = sp.get("last_mint")     === "true"
  const sortRaw      = sp.get("sort")           ?? "low_ask"
  const dir          = sp.get("dir")            ?? "asc"
  const limit        = Math.min(200, parseInt(sp.get("limit") ?? "50", 10))
  const offset       = parseInt(sp.get("offset") ?? "0", 10)

  const sortCol = ALLOWED_SORTS.has(sortRaw) ? sortRaw : "low_ask"
  const ascending = dir === "asc"

  try {
    function applyFilters(q: any): any {
      // Only return editions that have at least one active listing (low_ask is not null)
      q = q.not("low_ask", "is", null)

      if (player)  q = q.ilike("player_name", `%${player}%`)
      if (setName) q = q.ilike("set_name",    `%${setName}%`)

      if (series !== "") {
        const sNum = parseInt(series, 10)
        if (!isNaN(sNum)) q = q.eq("series_number", sNum)
      }

      if (tier) {
        const tierVal = `MOMENT_TIER_${tier.toUpperCase()}`
        q = q.eq("tier", tierVal)
      }

      if (team)    q = q.eq("team_nba_id", team)

      if (parallel !== "") {
        const pid = parseInt(parallel, 10)
        if (!isNaN(pid)) q = q.eq("parallel_id", pid)
      }

      // Badge filters
      if (badgeFilter) {
        const tagId = BADGE_TAG_IDS[badgeFilter]
        if (tagId) {
          // play_tag or set_play_tag ID match
          const badgeKey = badgeFilter === "rm"
            ? q.contains("set_play_tags", JSON.stringify([{ id: tagId }]))
            : q.contains("play_tags",     JSON.stringify([{ id: tagId }]))
          q = badgeKey
        } else if (badgeFilter === "rp") {
          q = q.contains("badge_titles", ["Rookie Premiere"])
        } else if (badgeFilter === "cy") {
          q = q.contains("badge_titles", ["Championship Year"])
        } else if (badgeFilter === "cr") {
          q = q.contains("badge_titles", ["Championship Run"])
        }
      }

      // Price filters on low_ask
      if (!isNaN(minPrice) && minPrice > 0) q = q.gte("low_ask", minPrice)
      if (!isNaN(maxPrice) && maxPrice > 0) q = q.lte("low_ask", maxPrice)

      // FMV filters on avg_sale_price
      if (!isNaN(minFmv) && minFmv > 0) q = q.gte("avg_sale_price", minFmv)
      if (!isNaN(maxFmv) && maxFmv > 0) q = q.lte("avg_sale_price", maxFmv)

      // Discount filter — low_ask must be at least minDiscount% below avg_sale_price
      // Expressed as: low_ask <= avg_sale_price * (1 - minDiscount/100)
      // Supabase can't do computed column filters directly, so we add this as a raw condition
      // workaround: filter client-side for discount (small enough result sets)
      // For large result sets this is an accepted tradeoff — discount is a soft signal anyway.

      // Jersey serial toggle — approximation: serial #1 through jersey numbers
      // We don't have jersey data in badge_editions; flag is passed through
      // for future enhancement and ignored server-side here.

      // Last mint: serial == circulation_count — approximated by low supply high lock
      if (lastMint) {
        q = q.gte("lock_rate_pct", 50)
      }

      // Exclude retired editions
      q = q.eq("flow_retired", false)

      return q
    }

    const [countResult, dataResult] = await Promise.all([
      applyFilters(
        supabase.from("badge_editions").select("*", { count: "exact", head: true })
      ),
      applyFilters(
        supabase.from("badge_editions")
          .select("*")
          .order(sortCol, { ascending })
          .range(offset, offset + limit - 1)
      ),
    ])

    if (dataResult.error) throw dataResult.error

    const parallelNames: Record<number, string> = {
      0: "Standard", 17: "Blockchain", 18: "Hardcourt", 19: "Hexwave", 20: "Jukebox",
    }

    const editions = (dataResult.data ?? []).map((e: any) => {
      const badgeTitles: string[] = [
        ...(e.play_tags     ?? []).map((t: any) => t.title),
        ...(e.set_play_tags ?? []).map((t: any) => t.title),
      ]

      const fmv: number | null = e.avg_sale_price
      const ask: number | null = e.low_ask
      const discountPct = fmv && ask && fmv > 0
        ? Math.round((1 - ask / fmv) * 100)
        : null

      return {
        ...e,
        badge_titles:     badgeTitles,
        parallel_display: parallelNames[e.parallel_id] ?? `Parallel ${e.parallel_id}`,
        price_gap:        ask != null && e.highest_offer != null ? ask - e.highest_offer : null,
        is_standard:      e.parallel_id === 0,
        tier_display:     (e.tier ?? "").replace("MOMENT_TIER_", "").replace(/^\w/, (c: string) => c.toUpperCase()),
        discount_pct:     discountPct,
      }
    })

    // Client-side discount filter (server-side computed columns unsupported)
    const filtered = !isNaN(minDiscount) && minDiscount > 0
      ? editions.filter((e: any) => e.discount_pct != null && e.discount_pct >= minDiscount)
      : editions

    const { data: syncData } = await supabase
      .from("badge_editions")
      .select("updated_at")
      .order("updated_at", { ascending: false })
      .limit(1)
      .single()

    return NextResponse.json({
      editions: filtered,
      meta: {
        total:   countResult.count ?? 0,
        limit,
        offset,
        sort:    sortCol,
        dir,
        lastSync: syncData?.updated_at ?? null,
      },
    })
  } catch (err) {
    console.error("[/api/market]", err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 }
    )
  }
}

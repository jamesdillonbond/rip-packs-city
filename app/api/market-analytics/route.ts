import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"

const COLLECTION_UUID_MAP: Record<string, string> = {
  "nba-top-shot": "95f28a17-224a-4025-96ad-adf8a4c63bfd",
  "nfl-all-day": "dee28451-5d62-409e-a1ad-a83f763ac070",
  "laliga-golazos": "06248cc4-b85f-47cd-af67-1855d14acd75",
  "disney-pinnacle": "7dd9dd11-e8b6-45c4-ac99-71331f959714",
}

function periodToDays(period: string): number {
  switch (period) {
    case "7d": return 7
    case "30d": return 30
    case "90d": return 90
    case "ytd": {
      const now = new Date()
      const jan1 = new Date(now.getFullYear(), 0, 1)
      return Math.max(1, Math.ceil((now.getTime() - jan1.getTime()) / 86400000))
    }
    case "all": return 365
    default: return 30
  }
}

const MAX_ROWS = 50000

function getStartDate(period: string): string {
  const now = new Date()
  switch (period) {
    case "7d":
      return new Date(now.getTime() - 7 * 86400000).toISOString().slice(0, 10)
    case "30d":
      return new Date(now.getTime() - 30 * 86400000).toISOString().slice(0, 10)
    case "90d":
      return new Date(now.getTime() - 90 * 86400000).toISOString().slice(0, 10)
    case "ytd":
      return `${now.getFullYear()}-01-01`
    case "all":
      return "2021-01-01"
    default:
      return new Date(now.getTime() - 30 * 86400000).toISOString().slice(0, 10)
  }
}

export async function GET(req: NextRequest) {
  const collectionSlug = req.nextUrl.searchParams.get("collection") || "nba-top-shot"
  const period = req.nextUrl.searchParams.get("period") || "30d"
  const detail = req.nextUrl.searchParams.get("detail") || "basic"
  const comparison = req.nextUrl.searchParams.get("comparison") === "true"
  const player = req.nextUrl.searchParams.get("player")?.trim() || null

  const collectionId = COLLECTION_UUID_MAP[collectionSlug]
  if (!collectionId) {
    return NextResponse.json({ error: "Unknown collection" }, { status: 400 })
  }

  const startDate = getStartDate(period)
  const startIso = `${startDate}T00:00:00Z`
  const endDate = new Date().toISOString().slice(0, 10)

  try {
    const { data: rows, error } = await (supabaseAdmin as any)
      .from("sales")
      .select("sold_at, price_usd, marketplace")
      .eq("collection_id", collectionId)
      .gte("sold_at", `${startDate}T00:00:00Z`)
      .order("sold_at", { ascending: true })
      .limit(MAX_ROWS)

    if (error) {
      console.log("[market-analytics] query error:", error.message)
      return NextResponse.json({ error: "Query failed" }, { status: 500 })
    }

    // Aggregate in JS
    const dailyMap = new Map<string, { saleCount: number; volume: number }>()
    let totalSales = 0
    let totalVolume = 0
    const marketplaces = new Set<string>()

    for (const row of rows || []) {
      const date = (row.sold_at as string).slice(0, 10)
      const mp = row.marketplace || "unknown"
      const price = parseFloat(row.price_usd) || 0
      const key = `${date}|${mp}`

      marketplaces.add(mp)
      totalSales++
      totalVolume += price

      const existing = dailyMap.get(key)
      if (existing) {
        existing.saleCount++
        existing.volume += price
      } else {
        dailyMap.set(key, { saleCount: 1, volume: price })
      }
    }

    const daily = Array.from(dailyMap.entries()).map(([key, val]) => {
      const [date, marketplace] = key.split("|")
      return {
        date,
        marketplace,
        saleCount: val.saleCount,
        volume: Math.round(val.volume * 100) / 100,
      }
    })

    const body: Record<string, unknown> = {
      period,
      startDate,
      endDate,
      totals: {
        totalSales,
        totalVolume: Math.round(totalVolume * 100) / 100,
      },
      daily,
    }

    if (detail === "full") {
      const [topSalesRes, tierRes, topEdRes, dailyTierRes, badgeRes, seriesRes, dailySeriesRes, playerRes] = await Promise.all([
        (supabaseAdmin as any).rpc("get_top_sales", {
          p_collection_id: collectionId,
          p_since: startIso,
          p_limit: 10,
        }),
        (supabaseAdmin as any).rpc("get_tier_analytics", {
          p_collection_id: collectionId,
          p_since: startIso,
        }),
        (supabaseAdmin as any).rpc("get_top_editions", {
          p_collection_id: collectionId,
          p_since: startIso,
          p_limit: 10,
        }),
        (supabaseAdmin as any).rpc("get_daily_tier_volume", {
          p_collection_id: collectionId,
          p_since: startIso,
        }),
        (supabaseAdmin as any).rpc("get_badge_premium", {
          p_collection_id: collectionId,
          p_since: startIso,
        }),
        (supabaseAdmin as any).rpc("get_series_analytics", {
          p_collection_id: collectionId,
          p_since: startIso,
        }),
        (supabaseAdmin as any).rpc("get_daily_series_volume", {
          p_collection_id: collectionId,
          p_since: startIso,
        }),
        player
          ? (supabaseAdmin as any).rpc("search_player_analytics", {
              p_collection_id: collectionId,
              p_player: player,
              p_since: startIso,
              p_limit: 20,
            })
          : Promise.resolve({ data: null, error: null }),
      ])

      if (topSalesRes.error) console.log("[market-analytics] get_top_sales:", topSalesRes.error.message)
      if (tierRes.error) console.log("[market-analytics] get_tier_analytics:", tierRes.error.message)
      if (topEdRes.error) console.log("[market-analytics] get_top_editions:", topEdRes.error.message)
      if (dailyTierRes.error) console.log("[market-analytics] get_daily_tier_volume:", dailyTierRes.error.message)
      if (badgeRes.error) console.log("[market-analytics] get_badge_premium:", badgeRes.error.message)
      if (seriesRes.error) console.log("[market-analytics] get_series_analytics:", seriesRes.error.message)
      if (dailySeriesRes.error) console.log("[market-analytics] get_daily_series_volume:", dailySeriesRes.error.message)
      if (playerRes?.error) console.log("[market-analytics] search_player_analytics:", playerRes.error.message)

      body.topSales = topSalesRes.data ?? []
      body.tierAnalytics = tierRes.data ?? []
      body.topEditions = topEdRes.data ?? []
      body.dailyTierVolume = dailyTierRes.data ?? []
      body.badgePremium = badgeRes.data ?? []
      body.seriesAnalytics = seriesRes.data ?? []
      body.dailySeriesVolume = dailySeriesRes.data ?? []
      if (player) body.playerSearch = playerRes?.data ?? []
    }

    if (comparison) {
      const days = periodToDays(period)
      const cmpRes = await (supabaseAdmin as any).rpc("get_period_comparison", {
        p_collection_id: collectionId,
        p_days: days,
      })
      if (cmpRes.error) {
        console.log("[market-analytics] get_period_comparison:", cmpRes.error.message)
        body.periodComparison = null
      } else {
        body.periodComparison = cmpRes.data ?? null
      }
    }

    const response = NextResponse.json(body)

    response.headers.set(
      "Cache-Control",
      "public, s-maxage=300, stale-while-revalidate=120"
    )

    return response
  } catch (err) {
    console.log("[market-analytics] error:", err instanceof Error ? err.message : String(err))
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}

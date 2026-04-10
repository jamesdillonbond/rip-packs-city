import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"

const COLLECTION_UUID_MAP: Record<string, string> = {
  "nba-top-shot": "95f28a17-224a-4025-96ad-adf8a4c63bfd",
  "nfl-all-day": "dee28451-5d62-409e-a1ad-a83f763ac070",
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

  const collectionId = COLLECTION_UUID_MAP[collectionSlug]
  if (!collectionId) {
    return NextResponse.json({ error: "Unknown collection" }, { status: 400 })
  }

  const startDate = getStartDate(period)
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

    const response = NextResponse.json({
      period,
      startDate,
      endDate,
      totals: {
        totalSales,
        totalVolume: Math.round(totalVolume * 100) / 100,
      },
      daily,
    })

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

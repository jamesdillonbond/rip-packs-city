import { NextResponse } from "next/server"

// ── In-process cache ──────────────────────────────────────────────────────────

let cache: { data: Record<string, unknown>; ts: number } | null = null
const CACHE_TTL = 5 * 60 * 1000 // 5 minutes

// ── GET /api/panini/market-stats ──────────────────────────────────────────────

export async function GET() {
  // Return cached data if fresh
  if (cache && Date.now() - cache.ts < CACHE_TTL) {
    return NextResponse.json(cache.data, {
      headers: { "Cache-Control": "public, max-age=300" },
    })
  }

  try {
    const res = await fetch(
      "https://api.opensea.io/api/v2/collections/paniniblockchain/stats",
      {
        headers: {
          "x-api-key": process.env.OPENSEA_API_KEY ?? "",
          Accept: "application/json",
        },
        next: { revalidate: 300 },
      }
    )

    if (!res.ok) {
      throw new Error(`OpenSea API returned ${res.status}`)
    }

    const json = await res.json()
    const total = json.total ?? json

    const data = {
      floor_price: total.floor_price ?? null,
      floor_price_symbol: "ETH",
      total_volume: total.total_volume ?? null,
      total_sales: total.total_sales ?? null,
      num_owners: total.num_owners ?? null,
      total_supply: total.total_supply ?? null,
      updated_at: new Date().toISOString(),
    }

    cache = { data, ts: Date.now() }

    return NextResponse.json(data, {
      headers: { "Cache-Control": "public, max-age=300" },
    })
  } catch (err) {
    // Return stale cache if available
    if (cache) {
      return NextResponse.json(cache.data, {
        headers: { "Cache-Control": "public, max-age=60" },
      })
    }

    return NextResponse.json(
      { error: "Failed to fetch market stats", detail: String(err) },
      { status: 502 }
    )
  }
}

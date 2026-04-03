import { NextResponse } from "next/server"

// ── In-process cache ──────────────────────────────────────────────────────────

interface CachedStats {
  data: Record<string, unknown>
  ts: number
}

let cache: CachedStats | null = null
const CACHE_TTL = 5 * 60 * 1000 // 5 minutes

// ── GET /api/panini/market-stats ──────────────────────────────────────────────

export async function GET() {
  const now = Date.now()

  // Return cached if fresh
  if (cache && now - cache.ts < CACHE_TTL) {
    return NextResponse.json(cache.data, {
      headers: { "Cache-Control": "public, max-age=300" },
    })
  }

  try {
    const apiKey = process.env.OPENSEA_API_KEY ?? ""
    const res = await fetch(
      "https://api.opensea.io/api/v2/collections/paniniblockchain/stats",
      {
        headers: { "x-api-key": apiKey },
        next: { revalidate: 300 },
      }
    )

    if (!res.ok) {
      throw new Error(`OpenSea API ${res.status}`)
    }

    const raw = await res.json()
    const stats = raw.total ?? raw

    const mapped = {
      floor_price: stats.floor_price ?? null,
      floor_price_symbol: "ETH",
      total_volume: stats.total_volume ?? null,
      total_sales: stats.total_sales ?? null,
      num_owners: stats.num_owners ?? null,
      total_supply: stats.total_supply ?? null,
      updated_at: new Date().toISOString(),
    }

    cache = { data: mapped, ts: now }

    return NextResponse.json(mapped, {
      headers: { "Cache-Control": "public, max-age=300" },
    })
  } catch (err) {
    // Return stale cache if available
    if (cache) {
      return NextResponse.json(cache.data, {
        headers: { "Cache-Control": "public, max-age=60" },
      })
    }

    const message = err instanceof Error ? err.message : "Unknown error"
    return NextResponse.json(
      { error: "Failed to fetch market stats", detail: message },
      { status: 502 }
    )
  }
}

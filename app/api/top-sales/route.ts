import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { getCollectionUuid } from "@/lib/collections"

// Multi-collection "Recent Top Sales" feed for the overview page.
// Uses the get_top_sales() RPC (defaults to 7 day lookback) for non-Pinnacle
// collections, and queries pinnacle_sales directly for Disney Pinnacle since
// that collection lives in its own table.
//
// Returns a normalised shape the overview page can consume:
//   { sales: [{ playerName, setName, tier, serialNumber, circulationCount, price }] }

type TopSaleRow = {
  playerName: string
  setName: string
  tier: string
  serialNumber: number
  circulationCount: number
  price: number
}

type RpcTopSaleRow = {
  player_name?: string | null
  set_name?: string | null
  tier?: string | null
  serial_number?: number | string | null
  circulation_count?: number | string | null
  price_usd?: number | string | null
}

async function pinnacleTopSales(limit: number, since: string): Promise<TopSaleRow[]> {
  const { data, error } = await (supabaseAdmin as any)
    .from("pinnacle_sales")
    .select(
      "sale_price_usd, serial_number, edition_id, sold_at, " +
        "pinnacle_editions(character_name, set_name, variant_type)"
    )
    .gte("sold_at", since)
    .order("sale_price_usd", { ascending: false })
    .limit(limit)
  if (error) {
    console.log("[top-sales] pinnacle err:", error.message)
    return []
  }
  return ((data ?? []) as any[]).map((r) => ({
    playerName: r.pinnacle_editions?.character_name ?? "Unknown",
    setName: r.pinnacle_editions?.set_name ?? "",
    tier: (r.pinnacle_editions?.variant_type ?? "").toString().toUpperCase(),
    serialNumber: Number(r.serial_number ?? 0),
    circulationCount: 0,
    price: Number(r.sale_price_usd ?? 0),
  }))
}

export async function GET(req: NextRequest) {
  const slug = req.nextUrl.searchParams.get("collection")?.trim() || "nba-top-shot"
  const limit = Math.min(
    Math.max(parseInt(req.nextUrl.searchParams.get("limit") ?? "5", 10) || 5, 1),
    25
  )

  const collectionId = getCollectionUuid(slug)
  if (!collectionId) return NextResponse.json({ sales: [] })

  const since = new Date(Date.now() - 7 * 86400000).toISOString()

  try {
    if (slug === "disney-pinnacle") {
      const sales = await pinnacleTopSales(limit, since)
      const res = NextResponse.json({ sales })
      res.headers.set(
        "Cache-Control",
        "public, s-maxage=300, stale-while-revalidate=600"
      )
      return res
    }

    const { data, error } = await (supabaseAdmin as any).rpc("get_top_sales", {
      p_collection_id: collectionId,
      p_since: since,
      p_limit: limit,
    })
    if (error) {
      console.log("[top-sales] rpc err:", error.message)
      return NextResponse.json({ sales: [] }, { status: 500 })
    }
    const rows = (data ?? []) as RpcTopSaleRow[]
    const sales: TopSaleRow[] = rows.map((r) => ({
      playerName: r.player_name ?? "Unknown",
      setName: r.set_name ?? "",
      tier: (r.tier ?? "").toString().toUpperCase(),
      serialNumber: Number(r.serial_number ?? 0),
      circulationCount: Number(r.circulation_count ?? 0),
      price: Number(r.price_usd ?? 0),
    }))

    const res = NextResponse.json({ sales })
    res.headers.set(
      "Cache-Control",
      "public, s-maxage=300, stale-while-revalidate=600"
    )
    return res
  } catch (err) {
    console.log(
      "[top-sales] error:",
      err instanceof Error ? err.message : String(err)
    )
    return NextResponse.json({ sales: [] }, { status: 500 })
  }
}

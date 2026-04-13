import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { getCollection } from "@/lib/collections"

const supabase: any = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

async function resolveCollectionId(slug: string | null): Promise<string | null> {
  if (!slug) return null
  const collectionObj = getCollection(slug)
  const contractName = collectionObj?.flowContractName
  if (!contractName) return null
  const { data } = await supabase
    .from("collection_config")
    .select("collection_id")
    .eq("flow_contract_name", contractName)
    .single()
  return data?.collection_id ?? null
}

export async function GET(req: NextRequest) {
  try {
    const collectionSlug = req.nextUrl.searchParams.get("collection")?.trim() || null
    const collectionId = await resolveCollectionId(collectionSlug)

    const moversParams: Record<string, any> = {
      lookback_interval: "24 hours",
      min_fmv: 1,
      limit_count: 5,
    }
    if (collectionId) moversParams.p_collection_id = collectionId

    const [editionsRes, highConfRes, volumeRes, moversRes] = await Promise.all([
      // (a) Count distinct editions in fmv_snapshots
      supabase
        .from("fmv_snapshots")
        .select("edition_id", { count: "exact", head: true }),
      // (b) Count HIGH confidence rows
      supabase
        .from("fmv_snapshots")
        .select("edition_id", { count: "exact", head: true })
        .eq("confidence", "HIGH"),
      // (d) 24h sales volume from sales_2026
      supabase
        .from("sales_2026")
        .select("price_usd")
        .gte("sold_at", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()),
      // (c) Top movers via RPC
      supabase.rpc("get_fmv_movers", moversParams),
    ])

    const totalEditions = editionsRes.count ?? 0
    const highConfCount = highConfRes.count ?? 0
    const volume24h = (volumeRes.data ?? []).reduce(
      (sum: number, r: { price_usd: number }) => sum + (Number(r.price_usd) || 0),
      0
    )
    const movers = moversRes.data ?? []

    return NextResponse.json(
      {
        totalEditions,
        highConfCount,
        volume24h,
        movers,
      },
      {
        headers: {
          "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600",
        },
      }
    )
  } catch (err) {
    console.log("[overview-stats] error:", err)
    return NextResponse.json(
      { totalEditions: 0, highConfCount: 0, volume24h: 0, movers: [] },
      { status: 500 }
    )
  }
}

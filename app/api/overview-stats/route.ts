import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import {
  getCollectionUuid,
  toDbSlug,
} from "@/lib/collections"

// Per-collection overview stats for the overview page KPI cards.
// Returns: totalEditions, highConfCount (HIGH-confidence FMV coverage),
// volume24h, and up to 5 FMV movers. All queries are filtered by the
// resolved collection UUID. Disney Pinnacle is routed to its dedicated
// tables (pinnacle_editions, pinnacle_fmv_snapshots, pinnacle_sales);
// all other collections hit the shared editions / fmv_snapshots / sales
// tables via collection_id.

type MarketPulseRow = {
  slug: string
  sales_24h: number | null
  volume_24h: number | null
}

async function getVolume24hFromPulse(dbSlug: string | null): Promise<number> {
  if (!dbSlug) return 0
  try {
    const { data, error } = await (supabaseAdmin as any).rpc(
      "get_market_pulse_all"
    )
    if (error) return 0
    const rows = (data ?? []) as MarketPulseRow[]
    const hit = rows.find((r) => r.slug === dbSlug)
    return Number(hit?.volume_24h ?? 0)
  } catch {
    return 0
  }
}

async function pinnacleStats() {
  const [editionsRes, highConfRes] = await Promise.all([
    (supabaseAdmin as any)
      .from("pinnacle_editions")
      .select("id", { count: "exact", head: true }),
    (supabaseAdmin as any)
      .from("pinnacle_fmv_snapshots")
      .select("edition_id", { count: "exact", head: true })
      .eq("confidence", "HIGH"),
  ])
  return {
    totalEditions: editionsRes.count ?? 0,
    highConfCount: highConfRes.count ?? 0,
  }
}

async function standardStats(collectionId: string) {
  const [editionsRes, highConfRes] = await Promise.all([
    (supabaseAdmin as any)
      .from("editions")
      .select("id", { count: "exact", head: true })
      .eq("collection_id", collectionId),
    (supabaseAdmin as any)
      .from("fmv_snapshots")
      .select("edition_id", { count: "exact", head: true })
      .eq("collection_id", collectionId)
      .eq("confidence", "HIGH"),
  ])
  return {
    totalEditions: editionsRes.count ?? 0,
    highConfCount: highConfRes.count ?? 0,
  }
}

export async function GET(req: NextRequest) {
  try {
    const slug = req.nextUrl.searchParams.get("collection")?.trim() || "nba-top-shot"
    const collectionId = getCollectionUuid(slug)
    const dbSlug = toDbSlug(slug)

    if (!collectionId) {
      return NextResponse.json(
        { totalEditions: 0, highConfCount: 0, volume24h: 0, movers: [] },
        { status: 200 }
      )
    }

    const isPinnacle = slug === "disney-pinnacle"

    const [stats, volume24h, moversRes] = await Promise.all([
      isPinnacle ? pinnacleStats() : standardStats(collectionId),
      getVolume24hFromPulse(dbSlug),
      // get_fmv_movers accepts p_collection_id but currently only walks
      // fmv_snapshots, so it naturally returns [] for Pinnacle — fine.
      (supabaseAdmin as any).rpc("get_fmv_movers", {
        lookback_interval: "24 hours",
        min_fmv: 1,
        limit_count: 5,
        p_collection_id: collectionId,
      }),
    ])

    return NextResponse.json(
      {
        totalEditions: stats.totalEditions,
        highConfCount: stats.highConfCount,
        volume24h,
        movers: moversRes.data ?? [],
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

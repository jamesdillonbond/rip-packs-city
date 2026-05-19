// GET /api/analytics/sets/series
//
// Thin wrapper over analytics_sets_series_overview(p_collections). Returns
// one row per (collection, series) pair with a roll-up of set / edition
// counts plus aggregate FMV figures.
//
// Query params:
//   collections  comma-separated list  (optional)

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { parseCollections } from "@/lib/analytics/window"
import { rpcWithRetry } from "@/lib/analytics/rpc-with-retry"
import type { SetsSeriesOverviewRow } from "@/lib/analytics-types"

export const dynamic = 'force-dynamic'
export const revalidate = 600

export async function GET(req: NextRequest) {
  const t0 = Date.now()
  try {
    const url = new URL(req.url)
    const collections = parseCollections(url.searchParams.get("collections"))

    console.log(
      `[analytics/sets/series] start collections=${collections?.join(",") ?? "all"}`
    )

    const { data, error } = await rpcWithRetry<SetsSeriesOverviewRow[]>(
      supabaseAdmin,
      "analytics_sets_series_overview",
      { p_collections: collections }
    )

    if (error) {
      console.log("[analytics/sets/series] rpc_error", error.message)
      return NextResponse.json({ error: "sets_series_failed" }, { status: 500 })
    }

    const rows = (data ?? []) as SetsSeriesOverviewRow[]
    console.log(
      `[analytics/sets/series] ok elapsed=${Date.now() - t0}ms rows=${rows.length}`
    )

    return NextResponse.json(
      { rows },
      {
        headers: {
          "Cache-Control": "public, max-age=0, s-maxage=600, stale-while-revalidate=1200",
        },
      }
    )
  } catch (e: any) {
    console.log("[analytics/sets/series] error", e?.message || e, `elapsed=${Date.now() - t0}ms`)
    return NextResponse.json({ error: "sets_series_failed" }, { status: 500 })
  }
}

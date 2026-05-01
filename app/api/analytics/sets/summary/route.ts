// GET /api/analytics/sets/summary
//
// Thin wrapper over analytics_sets_summary(p_collections). Returns a
// per-collection summary of sets and editions with tier breakdown.
//
// Query params:
//   collections  comma-separated list  (optional)

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { parseCollections } from "@/lib/analytics/window"
import { rpcWithRetry } from "@/lib/analytics/rpc-with-retry"
import type { SetsSummaryResponse } from "@/lib/analytics-types"

export const revalidate = 600

export async function GET(req: NextRequest) {
  const t0 = Date.now()
  try {
    const url = new URL(req.url)
    const collections = parseCollections(url.searchParams.get("collections"))

    console.log(
      `[analytics/sets/summary] start collections=${collections?.join(",") ?? "all"}`
    )

    const { data, error } = await rpcWithRetry<SetsSummaryResponse>(
      supabaseAdmin,
      "analytics_sets_summary",
      { p_collections: collections }
    )

    if (error) {
      console.log("[analytics/sets/summary] rpc_error", error.message)
      return NextResponse.json({ error: "sets_summary_failed" }, { status: 500 })
    }

    console.log(`[analytics/sets/summary] ok elapsed=${Date.now() - t0}ms`)

    return NextResponse.json(data, {
      headers: {
        "Cache-Control": "public, max-age=0, s-maxage=600, stale-while-revalidate=1200",
      },
    })
  } catch (e: any) {
    console.log("[analytics/sets/summary] error", e?.message || e, `elapsed=${Date.now() - t0}ms`)
    return NextResponse.json({ error: "sets_summary_failed" }, { status: 500 })
  }
}

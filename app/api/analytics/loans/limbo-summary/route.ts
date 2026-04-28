// GET /api/analytics/loans/limbo-summary
//
// Thin wrapper over flowty_analytics_limbo_summary(p_collections). The Limbo
// cohort is loans that originated before our backfill window (Dec 28 2025)
// but reached terminal state inside our window. Surfaced separately so they
// don't inflate the originated-in-window KPIs.
//
// Query params:
//   collections comma-separated list (optional)

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { parseCollections } from "@/lib/analytics/loans-window"
import type { AnalyticsLimboSummary } from "@/lib/analytics-types"

export const revalidate = 600

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url)
    const collections = parseCollections(url.searchParams.get("collections"))

    const { data, error } = await supabaseAdmin.rpc("flowty_analytics_limbo_summary", {
      p_collections: collections,
    })

    if (error) {
      console.log("[analytics/loans/limbo-summary] rpc_error", error.message)
      return NextResponse.json({ error: "limbo_summary_failed" }, { status: 500 })
    }

    const payload = data as AnalyticsLimboSummary | null

    return NextResponse.json(payload, {
      headers: {
        "Cache-Control": "public, max-age=0, s-maxage=600, stale-while-revalidate=1200",
      },
    })
  } catch (e: any) {
    console.log("[analytics/loans/limbo-summary] error", e?.message || e)
    return NextResponse.json({ error: "limbo_summary_failed" }, { status: 500 })
  }
}

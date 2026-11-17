// GET /api/analytics/loans/summary
//
// Thin wrapper over flowty_analytics_summary(p_start_at, p_end_at, p_collections).
// The RPC is the single source of truth for funded-loan KPIs and prior-period
// deltas. Returns the RPC payload verbatim.
//
// Query params:
//   window      l7 | l30 | l90 | ytd | y2026 | y2025 | all  (default all)
//   collections comma-separated list                         (optional)

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { parseWindow, windowRange, parseCollections } from "@/lib/analytics/window"
import { rpcWithRetry } from "@/lib/analytics/rpc-with-retry"
import type { AnalyticsSummaryResponse } from "@/lib/analytics-types"

export const dynamic = 'force-dynamic'
export const revalidate = 600

export async function GET(req: NextRequest) {
  const t0 = Date.now()
  try {
    const url = new URL(req.url)
    const window = parseWindow(url.searchParams.get("window"))
    const collections = parseCollections(url.searchParams.get("collections"))
    const range = windowRange(window)

    console.log(
      `[analytics/loans/summary] start window=${window} collections=${collections?.join(",") ?? "all"}`
    )

    const { data, error } = await rpcWithRetry<AnalyticsSummaryResponse>(
      supabaseAdmin,
      "flowty_analytics_summary",
      {
        p_start_at: range.startISO,
        p_end_at: range.endISO,
        p_collections: collections,
      }
    )

    if (error) {
      console.log("[analytics/loans/summary] rpc_error", error.message)
      return NextResponse.json({ error: "summary_failed" }, { status: 500 })
    }

    console.log(
      `[analytics/loans/summary] ok elapsed=${Date.now() - t0}ms total_loans=${data?.total_loans ?? 0}`
    )

    return NextResponse.json(data, {
      headers: {
        "Cache-Control": "public, max-age=0, s-maxage=600, stale-while-revalidate=1200",
      },
    })
  } catch (e: any) {
    console.log("[analytics/loans/summary] error", e?.message || e, `elapsed=${Date.now() - t0}ms`)
    return NextResponse.json({ error: "summary_failed" }, { status: 500 })
  }
}

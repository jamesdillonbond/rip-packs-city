// GET /api/analytics/sales/summary
//
// Thin wrapper over analytics_sales_summary(p_start_at, p_end_at, p_collections).
// Returns the jsonb response verbatim — totals, percentile spread, prior-period
// deltas, and per-collection / per-marketplace roll-ups.
//
// Query params:
//   window      l7 | l30 | l90 | ytd | y2026 | y2025 | all  (default all)
//   collections comma-separated list                         (optional)

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { parseWindow, windowRange, parseCollections } from "@/lib/analytics/window"
import { rpcWithRetry } from "@/lib/analytics/rpc-with-retry"
import type { SalesSummaryResponse } from "@/lib/analytics-types"

export const revalidate = 600

export async function GET(req: NextRequest) {
  const t0 = Date.now()
  try {
    const url = new URL(req.url)
    const window = parseWindow(url.searchParams.get("window"))
    const collections = parseCollections(url.searchParams.get("collections"))
    const range = windowRange(window)

    console.log(
      `[analytics/sales/summary] start window=${window} collections=${collections?.join(",") ?? "all"}`
    )

    // Always pass an explicit p_end_at — when window=all, windowRange returns
    // null endISO. The RPC's prior-period delta logic only computes when both
    // start and end bounds are set, so we anchor end to "now" so the SalesDashboard
    // delta chips populate correctly for every window.
    const endISO = range.endISO ?? new Date().toISOString()

    const { data, error } = await rpcWithRetry<SalesSummaryResponse>(
      supabaseAdmin,
      "analytics_sales_summary",
      {
        p_start_at: range.startISO,
        p_end_at: endISO,
        p_collections: collections,
      }
    )

    if (error) {
      console.log("[analytics/sales/summary] rpc_error", error.message)
      return NextResponse.json({ error: "summary_failed" }, { status: 500 })
    }

    console.log(
      `[analytics/sales/summary] ok elapsed=${Date.now() - t0}ms total_sales=${data?.total_sales ?? 0}`
    )

    return NextResponse.json(data, {
      headers: {
        "Cache-Control": "public, max-age=0, s-maxage=600, stale-while-revalidate=1200",
      },
    })
  } catch (e: any) {
    console.log("[analytics/sales/summary] error", e?.message || e, `elapsed=${Date.now() - t0}ms`)
    return NextResponse.json({ error: "summary_failed" }, { status: 500 })
  }
}

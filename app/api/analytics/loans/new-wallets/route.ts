// GET /api/analytics/loans/new-wallets
//
// Thin wrapper over flowty_analytics_new_wallets(p_start_at, p_end_at,
// p_collections). Bucketing is owned by the RPC; the client renders the
// rows as-is.
//
// Query params:
//   window      l7 | l30 | l90 | ytd | y2026 | y2025 | all  (default all)
//   collections comma-separated list                         (optional)

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { parseWindow, windowRange, parseCollections } from "@/lib/analytics/window"
import { rpcWithRetry } from "@/lib/analytics/rpc-with-retry"
import type { AnalyticsNewWalletsRow } from "@/lib/analytics-types"

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
      `[analytics/loans/new-wallets] start window=${window} collections=${collections?.join(",") ?? "all"}`
    )

    const { data, error } = await rpcWithRetry<AnalyticsNewWalletsRow[]>(
      supabaseAdmin,
      "flowty_analytics_new_wallets",
      {
        p_start_at: range.startISO,
        p_end_at: range.endISO,
        p_collections: collections,
      }
    )

    if (error) {
      console.log("[analytics/loans/new-wallets] rpc_error", error.message)
      return NextResponse.json({ error: "new_wallets_failed" }, { status: 500 })
    }

    const rows = (data ?? []) as AnalyticsNewWalletsRow[]
    console.log(
      `[analytics/loans/new-wallets] ok elapsed=${Date.now() - t0}ms rows=${rows.length}`
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
    console.log("[analytics/loans/new-wallets] error", e?.message || e, `elapsed=${Date.now() - t0}ms`)
    return NextResponse.json({ error: "new_wallets_failed" }, { status: 500 })
  }
}

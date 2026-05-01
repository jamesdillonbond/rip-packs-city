// GET /api/analytics/wallets/overview
//
// Thin wrapper over analytics_wallets_overview(). Returns hub-level totals
// (wallets, borrowers, lenders, dollar volume) plus segment + recency cuts
// for the loan-book wallet directory.
//
// No query params.

import { NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { rpcWithRetry } from "@/lib/analytics/rpc-with-retry"
import type { WalletsOverviewResponse } from "@/lib/analytics-types"

export const revalidate = 600

export async function GET() {
  const t0 = Date.now()
  try {
    console.log("[analytics/wallets/overview] start")

    const { data, error } = await rpcWithRetry<WalletsOverviewResponse>(
      supabaseAdmin,
      "analytics_wallets_overview",
      {}
    )

    if (error) {
      console.log("[analytics/wallets/overview] rpc_error", error.message)
      return NextResponse.json({ error: "wallets_overview_failed" }, { status: 500 })
    }

    console.log(`[analytics/wallets/overview] ok elapsed=${Date.now() - t0}ms`)

    return NextResponse.json(data, {
      headers: {
        "Cache-Control": "public, max-age=0, s-maxage=600, stale-while-revalidate=1200",
      },
    })
  } catch (e: any) {
    console.log("[analytics/wallets/overview] error", e?.message || e, `elapsed=${Date.now() - t0}ms`)
    return NextResponse.json({ error: "wallets_overview_failed" }, { status: 500 })
  }
}

// GET /api/analytics/loans/position-transfers
//
// Thin wrapper over analytics_position_transfers_summary(). Returns the
// totals, top origin/recipient lenders, and the most recent 25 transfers.

import { NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { rpcWithRetry } from "@/lib/analytics/rpc-with-retry"
import type { PositionTransfersSummaryResponse } from "@/lib/analytics-types"

export const revalidate = 600

export async function GET() {
  const t0 = Date.now()
  try {
    const { data, error } = await rpcWithRetry<PositionTransfersSummaryResponse>(
      supabaseAdmin,
      "analytics_position_transfers_summary",
      {}
    )
    if (error) {
      console.log("[loans/position-transfers] rpc_error", error.message)
      return NextResponse.json({ error: "position_transfers_failed" }, { status: 500 })
    }

    console.log(
      `[loans/position-transfers] ok elapsed=${Date.now() - t0}ms transfers=${data?.totals?.total_transfers ?? 0}`
    )

    return NextResponse.json(data ?? null, {
      headers: {
        "Cache-Control": "public, max-age=0, s-maxage=600, stale-while-revalidate=1200",
      },
    })
  } catch (e: any) {
    console.log("[loans/position-transfers] error", e?.message || e)
    return NextResponse.json({ error: "position_transfers_failed" }, { status: 500 })
  }
}

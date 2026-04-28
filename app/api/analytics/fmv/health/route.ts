// GET /api/analytics/fmv/health
//
// Thin wrapper over analytics_fmv_pipeline_health(). Returns a per-collection
// snapshot of the FMV pipeline — confidence-bucket counts, reliable totals,
// and last-refresh timing.
//
// No query params.

import { NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { rpcWithRetry } from "@/lib/analytics/rpc-with-retry"
import type { FmvPipelineHealthResponse } from "@/lib/analytics-types"

export const revalidate = 600

export async function GET() {
  const t0 = Date.now()
  try {
    console.log("[analytics/fmv/health] start")

    const { data, error } = await rpcWithRetry<FmvPipelineHealthResponse>(
      supabaseAdmin,
      "analytics_fmv_pipeline_health",
      {}
    )

    if (error) {
      console.log("[analytics/fmv/health] rpc_error", error.message)
      return NextResponse.json({ error: "fmv_health_failed" }, { status: 500 })
    }

    const collections = data?.collections ? Object.keys(data.collections).join(",") : "none"
    console.log(
      `[analytics/fmv/health] ok elapsed=${Date.now() - t0}ms collections=${collections}`
    )

    return NextResponse.json(data, {
      headers: {
        "Cache-Control": "public, max-age=0, s-maxage=600, stale-while-revalidate=1200",
      },
    })
  } catch (e: any) {
    console.log("[analytics/fmv/health] error", e?.message || e, `elapsed=${Date.now() - t0}ms`)
    return NextResponse.json({ error: "fmv_health_failed" }, { status: 500 })
  }
}

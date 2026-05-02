// GET /api/analytics/health
//
// Thin wrapper over analytics_pipeline_health(). Cached aggressively at
// 60s — the analytics overview header polls this every minute.

import { NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { rpcWithRetry } from "@/lib/analytics/rpc-with-retry"
import type { PipelineHealthResponse } from "@/lib/analytics-types"

export const revalidate = 60

export async function GET() {
  const t0 = Date.now()
  try {
    const { data, error } = await rpcWithRetry<PipelineHealthResponse>(
      supabaseAdmin,
      "analytics_pipeline_health",
      {}
    )
    if (error) {
      console.log("[health] rpc_error", error.message)
      return NextResponse.json({ error: "health_failed" }, { status: 500 })
    }

    console.log(
      `[health] ok elapsed=${Date.now() - t0}ms status=${data?.overall_status ?? "unknown"}`
    )

    return NextResponse.json(data ?? null, {
      headers: {
        "Cache-Control": "public, max-age=0, s-maxage=60, stale-while-revalidate=120",
      },
    })
  } catch (e: any) {
    console.log("[health] error", e?.message || e)
    return NextResponse.json({ error: "health_failed" }, { status: 500 })
  }
}

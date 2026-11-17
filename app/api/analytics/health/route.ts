// GET /api/analytics/health
//
// Thin wrapper over analytics_pipeline_health(). Cached aggressively at
// 60s — the analytics overview header polls this every minute.

import { NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { rpcWithRetry } from "@/lib/analytics/rpc-with-retry"
import type { PipelineHealthResponse } from "@/lib/analytics-types"

// force-dynamic matches every sibling analytics route. Without it, `revalidate`
// alone makes Next prerender this handler at BUILD time — so the deploy runs
// analytics_pipeline_health() under the 29-worker prerender burst (it blew its
// own 5s function-local statement_timeout there on 2026-07-28, page 309/412)
// and bakes the resulting 500 in as the first snapshot. The 60s edge cache
// comes from the Cache-Control header below, not from ISR.
export const dynamic = 'force-dynamic'
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

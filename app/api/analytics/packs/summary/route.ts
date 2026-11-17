// GET /api/analytics/packs/summary
//
// Thin wrapper over analytics_packs_summary(p_collections). Returns a
// per-collection summary of pack listings — counts, price stats, and
// freshness signals.
//
// Query params:
//   collections  comma-separated list  (optional)

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { parseCollections } from "@/lib/analytics/window"
import { rpcWithRetry } from "@/lib/analytics/rpc-with-retry"

export const dynamic = 'force-dynamic'
export const revalidate = 600

export async function GET(req: NextRequest) {
  const t0 = Date.now()
  try {
    const url = new URL(req.url)
    const collections = parseCollections(url.searchParams.get("collections"))

    console.log(
      `[analytics/packs/summary] start collections=${collections?.join(",") ?? "all"}`
    )

    const { data, error } = await rpcWithRetry<unknown>(
      supabaseAdmin,
      "analytics_packs_summary",
      { p_collections: collections }
    )

    if (error) {
      console.log("[analytics/packs/summary] rpc_error", error.message)
      return NextResponse.json({ error: "packs_summary_failed" }, { status: 500 })
    }

    console.log(`[analytics/packs/summary] ok elapsed=${Date.now() - t0}ms`)

    return NextResponse.json(data, {
      headers: {
        "Cache-Control": "public, max-age=0, s-maxage=600, stale-while-revalidate=1200",
      },
    })
  } catch (e: any) {
    console.log("[analytics/packs/summary] error", e?.message || e, `elapsed=${Date.now() - t0}ms`)
    return NextResponse.json({ error: "packs_summary_failed" }, { status: 500 })
  }
}

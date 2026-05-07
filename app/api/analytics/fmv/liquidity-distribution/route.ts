// GET /api/analytics/fmv/liquidity-distribution
//
// Thin wrapper over analytics_liquidity_distribution(p_collections). Returns
// per-collection roll-ups of editions bucketed by liquidity_rating (L5..L1
// plus a 'cold' bucket for editions with no rating). The RPC joins through
// fmv_snapshots.collection_id rather than the denormalized text column —
// see the data-quality note about fmv_snapshots.collection mislabeling.
//
// Query params:
//   collections  comma-separated list  (optional — null = all)

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { parseCollections } from "@/lib/analytics/window"
import { rpcWithRetry } from "@/lib/analytics/rpc-with-retry"
import type { LiquidityDistributionResponse } from "@/lib/analytics-types"

export const revalidate = 600

export async function GET(req: NextRequest) {
  const t0 = Date.now()
  try {
    const url = new URL(req.url)
    const collections = parseCollections(url.searchParams.get("collections"))

    console.log(
      `[analytics/fmv/liquidity-distribution] start collections=${collections?.join(",") ?? "all"}`
    )

    const { data, error } = await rpcWithRetry<LiquidityDistributionResponse>(
      supabaseAdmin,
      "analytics_liquidity_distribution",
      { p_collections: collections }
    )

    if (error) {
      console.log("[analytics/fmv/liquidity-distribution] rpc_error", error.message)
      return NextResponse.json({ error: "liquidity_distribution_failed" }, { status: 500 })
    }

    const payload = (data ?? { as_of: new Date().toISOString(), rows: [] }) as LiquidityDistributionResponse
    console.log(
      `[analytics/fmv/liquidity-distribution] ok elapsed=${Date.now() - t0}ms rows=${payload.rows?.length ?? 0}`
    )

    return NextResponse.json(payload, {
      headers: {
        "Cache-Control": "public, max-age=0, s-maxage=600, stale-while-revalidate=1200",
      },
    })
  } catch (e: any) {
    console.log("[analytics/fmv/liquidity-distribution] error", e?.message || e, `elapsed=${Date.now() - t0}ms`)
    return NextResponse.json({ error: "liquidity_distribution_failed" }, { status: 500 })
  }
}

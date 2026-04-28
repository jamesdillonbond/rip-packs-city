// GET /api/analytics/fmv/tier-pulse
//
// Thin wrapper over analytics_fmv_tier_pulse(p_collections). Returns
// per-tier roll-ups (edition count, total/avg/median FMV, confidence
// distribution) for each requested collection.
//
// Query params:
//   collections  comma-separated list  (optional)

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { parseCollections } from "@/lib/analytics/window"
import { rpcWithRetry } from "@/lib/analytics/rpc-with-retry"
import type { FmvTierPulseRow } from "@/lib/analytics-types"

export const revalidate = 600

export async function GET(req: NextRequest) {
  const t0 = Date.now()
  try {
    const url = new URL(req.url)
    const collections = parseCollections(url.searchParams.get("collections"))

    console.log(
      `[analytics/fmv/tier-pulse] start collections=${collections?.join(",") ?? "all"}`
    )

    const { data, error } = await rpcWithRetry<FmvTierPulseRow[]>(
      supabaseAdmin,
      "analytics_fmv_tier_pulse",
      { p_collections: collections }
    )

    if (error) {
      console.log("[analytics/fmv/tier-pulse] rpc_error", error.message)
      return NextResponse.json({ error: "fmv_tier_pulse_failed" }, { status: 500 })
    }

    const rows = (data ?? []) as FmvTierPulseRow[]
    console.log(
      `[analytics/fmv/tier-pulse] ok elapsed=${Date.now() - t0}ms rows=${rows.length}`
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
    console.log("[analytics/fmv/tier-pulse] error", e?.message || e, `elapsed=${Date.now() - t0}ms`)
    return NextResponse.json({ error: "fmv_tier_pulse_failed" }, { status: 500 })
  }
}

// GET /api/analytics/pulse/24h
//
// Thin wrapper over analytics_pulse_24h(p_collections). Returns a 24h
// rolling snapshot — loan + sale activity totals plus a prior-period
// pair so the dashboard can render delta percentages without a second
// roundtrip.
//
// Cache window is shorter than the rest of /analytics (60s) since this
// powers the "live" surface.
//
// Query params:
//   collections  comma-separated list  (optional)

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { parseCollections } from "@/lib/analytics/window"
import { rpcWithRetry } from "@/lib/analytics/rpc-with-retry"
import type { Pulse24hResponse } from "@/lib/analytics-types"

export const dynamic = 'force-dynamic'
export const revalidate = 60

export async function GET(req: NextRequest) {
  const t0 = Date.now()
  try {
    const url = new URL(req.url)
    const collections = parseCollections(url.searchParams.get("collections"))

    console.log(
      `[analytics/pulse/24h] start collections=${collections?.join(",") ?? "all"}`
    )

    const { data, error } = await rpcWithRetry<Pulse24hResponse>(
      supabaseAdmin,
      "analytics_pulse_24h",
      { p_collections: collections }
    )

    if (error) {
      console.log("[analytics/pulse/24h] rpc_error", error.message)
      return NextResponse.json({ error: "pulse_24h_failed" }, { status: 500 })
    }

    console.log(
      `[analytics/pulse/24h] ok elapsed=${Date.now() - t0}ms sales=${data?.sales?.sales ?? 0} loans=${data?.loans?.originations ?? 0}`
    )

    return NextResponse.json(data, {
      headers: {
        "Cache-Control": "public, max-age=0, s-maxage=60, stale-while-revalidate=120",
      },
    })
  } catch (e: any) {
    console.log("[analytics/pulse/24h] error", e?.message || e, `elapsed=${Date.now() - t0}ms`)
    return NextResponse.json({ error: "pulse_24h_failed" }, { status: 500 })
  }
}

// GET /api/analytics/pulse/hourly
//
// Thin wrapper over analytics_pulse_hourly(p_hours, p_collections).
// Pre-bucketed and gap-filled by the RPC, so we hand the rows straight
// through to the client — no client-side bucketing needed.
//
// Query params:
//   hours        default 24, max 168 (7 days)        (optional)
//   collections  comma-separated list                (optional)

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { parseCollections } from "@/lib/analytics/window"
import { rpcWithRetry } from "@/lib/analytics/rpc-with-retry"
import type { PulseHourlyRow } from "@/lib/analytics-types"

export const revalidate = 60

function parseHours(raw: string | null): number {
  const n = raw ? parseInt(raw, 10) : 24
  if (!Number.isFinite(n) || n <= 0) return 24
  return Math.min(168, Math.max(1, n))
}

export async function GET(req: NextRequest) {
  const t0 = Date.now()
  try {
    const url = new URL(req.url)
    const collections = parseCollections(url.searchParams.get("collections"))
    const hours = parseHours(url.searchParams.get("hours"))

    console.log(
      `[analytics/pulse/hourly] start hours=${hours} collections=${collections?.join(",") ?? "all"}`
    )

    const { data, error } = await rpcWithRetry<PulseHourlyRow[]>(
      supabaseAdmin,
      "analytics_pulse_hourly",
      {
        p_hours: hours,
        p_collections: collections,
      }
    )

    if (error) {
      console.log("[analytics/pulse/hourly] rpc_error", error.message)
      return NextResponse.json({ error: "pulse_hourly_failed" }, { status: 500 })
    }

    const rows = (data ?? []) as PulseHourlyRow[]
    console.log(
      `[analytics/pulse/hourly] ok elapsed=${Date.now() - t0}ms rows=${rows.length}`
    )

    return NextResponse.json(
      { rows, hours },
      {
        headers: {
          "Cache-Control": "public, max-age=0, s-maxage=60, stale-while-revalidate=120",
        },
      }
    )
  } catch (e: any) {
    console.log("[analytics/pulse/hourly] error", e?.message || e, `elapsed=${Date.now() - t0}ms`)
    return NextResponse.json({ error: "pulse_hourly_failed" }, { status: 500 })
  }
}

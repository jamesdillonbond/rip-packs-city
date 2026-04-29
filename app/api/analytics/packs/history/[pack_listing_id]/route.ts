// GET /api/analytics/packs/history/[pack_listing_id]
//
// Thin wrapper over analytics_packs_history(p_pack_listing_id, p_days).
// Returns the historical price/ask trajectory for a single pack listing.
//
// Path param:
//   pack_listing_id  pack listing identifier
// Query param:
//   days             look-back days  (default 30, max 90)

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { rpcWithRetry } from "@/lib/analytics/rpc-with-retry"

export const revalidate = 600

function parseDays(raw: string | null): number {
  const n = raw ? parseInt(raw, 10) : 30
  if (!Number.isFinite(n) || n <= 0) return 30
  return Math.min(90, Math.max(1, n))
}

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ pack_listing_id: string }> }
) {
  const t0 = Date.now()
  try {
    const { pack_listing_id } = await ctx.params
    const id = (pack_listing_id || "").trim()
    if (!id) {
      return NextResponse.json({ error: "invalid_pack_listing_id" }, { status: 400 })
    }

    const url = new URL(req.url)
    const days = parseDays(url.searchParams.get("days"))

    console.log(
      `[analytics/packs/history] start pack_listing_id=${id} days=${days}`
    )

    const { data, error } = await rpcWithRetry<unknown>(
      supabaseAdmin,
      "analytics_packs_history",
      { p_pack_listing_id: id, p_days: days }
    )

    if (error) {
      console.log("[analytics/packs/history] rpc_error", error.message)
      return NextResponse.json({ error: "packs_history_failed" }, { status: 500 })
    }

    console.log(
      `[analytics/packs/history] ok pack_listing_id=${id} elapsed=${Date.now() - t0}ms`
    )

    return NextResponse.json(data, {
      headers: {
        "Cache-Control": "public, max-age=0, s-maxage=600, stale-while-revalidate=1200",
      },
    })
  } catch (e: any) {
    console.log("[analytics/packs/history] error", e?.message || e, `elapsed=${Date.now() - t0}ms`)
    return NextResponse.json({ error: "packs_history_failed" }, { status: 500 })
  }
}

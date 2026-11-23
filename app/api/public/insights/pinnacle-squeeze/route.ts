// app/api/public/insights/pinnacle-squeeze/route.ts
//
// PUBLIC INSIGHTS — Disney Pinnacle Listed-Share Squeeze (2026-11-23): pins ranked by the share of their collector-held
// copies listed in the last complete listings sweep. JSON twin of /insights/pinnacle-squeeze; the read lives in
// lib/insights/pinnacle-boards.ts. A failed read is boardUnavailable, never an empty board.
//
// Query params: min_held=<1..10000> (default 25) · limit=<1..500> (default 100). A malformed value is a 400.
// CACHE: 30-min s-maxage (the listings sweep runs ~5×/day).

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin as supabase } from "@/lib/supabase"
import { boardUnavailable } from "@/lib/insights/board-error"
import { withBoardBudget } from "@/lib/insights/board-page-fetch"
import { fetchPinnacleSqueeze } from "@/lib/insights/pinnacle-boards"

function intParam(raw: string | null, def: number, lo: number, hi: number): number | null {
  if (raw == null || raw === "") return def
  if (!/^\d+$/.test(raw)) return null
  const n = Number(raw)
  return n >= lo && n <= hi ? n : null
}

export async function GET(req: NextRequest) {
  const startedAt = Date.now()
  const sp = new URL(req.url).searchParams
  const minHeld = intParam(sp.get("min_held"), 25, 1, 10_000)
  const limit = intParam(sp.get("limit"), 100, 1, 500)
  if (minHeld == null || limit == null) {
    return NextResponse.json({ error: "min_held must be 1..10000 and limit 1..500" }, { status: 400 })
  }
  let payload
  try {
    payload = await withBoardBudget(fetchPinnacleSqueeze(supabase, { minHeld, limit }), "pinnacle-squeeze")
  } catch (e) {
    return boardUnavailable(e, "insights/pinnacle-squeeze")
  }
  const res = NextResponse.json({
    meta: {
      fetched_at: new Date().toISOString(),
      source: "get_pinnacle_listed_squeeze",
      elapsed_ms: Date.now() - startedAt,
      listings_seen_at: payload.listings_seen_at,
      min_held: payload.min_held,
      pins_ranked: payload.pins_ranked,
      pins_zero_listed: payload.pins_zero_listed,
      filters: { min_held: minHeld, limit },
    },
    rows: payload.rows,
  })
  res.headers.set("Cache-Control", "public, s-maxage=1800, stale-while-revalidate=300")
  return res
}

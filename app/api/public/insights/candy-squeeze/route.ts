// app/api/public/insights/candy-squeeze/route.ts
//
// PUBLIC INSIGHTS — Candy Listed-Share Squeeze (2026-11-23, Candy parity pass 1): 2026 Candy ICONs ranked by the
// share of their collector-held copies with a confirmed Magic Eden listing. JSON twin of /insights/candy-squeeze; the
// read lives in lib/insights/candy-parity-boards.ts. A failed read is boardUnavailable, never an empty board.
//
// Query params: min_held=<1..10000> (default 25) · limit=<1..500> (default 300). A malformed value is a 400.
// CACHE: 30-min s-maxage (the Candy listings sweep runs every 3 h).

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin as supabase } from "@/lib/supabase"
import { boardUnavailable } from "@/lib/insights/board-error"
import { withBoardBudget } from "@/lib/insights/board-page-fetch"
import { fetchCandySqueeze } from "@/lib/insights/candy-parity-boards"

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
  const limit = intParam(sp.get("limit"), 300, 1, 500)
  if (minHeld == null || limit == null) {
    return NextResponse.json({ error: "min_held must be 1..10000 and limit 1..500" }, { status: 400 })
  }
  let payload
  try {
    payload = await withBoardBudget(fetchCandySqueeze(supabase, { minHeld, limit }), "candy-squeeze")
  } catch (e) {
    return boardUnavailable(e, "insights/candy-squeeze")
  }
  const res = NextResponse.json({
    meta: {
      fetched_at: new Date().toISOString(),
      source: "get_candy_listed_squeeze",
      elapsed_ms: Date.now() - startedAt,
      listings_seen_at: payload.listings_seen_at,
      min_held: payload.min_held,
      editions_ranked: payload.editions_ranked,
      editions_zero_listed: payload.editions_zero_listed,
      filters: { min_held: minHeld, limit },
    },
    rows: payload.rows,
  })
  res.headers.set("Cache-Control", "public, s-maxage=1800, stale-while-revalidate=300")
  return res
}

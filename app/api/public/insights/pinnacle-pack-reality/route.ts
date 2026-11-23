// app/api/public/insights/pinnacle-pack-reality/route.ts
//
// PUBLIC INSIGHTS — Disney Pinnacle Pack Reality (2026-11-23): per Pinnacle drop since 2026-09, retail
// price vs what its opened packs' pulls were worth at open and are worth today. JSON twin of
// /insights/pinnacle-pack-reality; the read lives in lib/insights/pinnacle-pack-reality-board.ts.
// A failed read is boardUnavailable (503), never an empty board.
//
// CACHE: 30-min s-maxage (pack opens ingest within the hour; render FMV recalcs every ~3 h).

import { NextResponse } from "next/server"
import { supabaseAdmin as supabase } from "@/lib/supabase"
import { boardUnavailable } from "@/lib/insights/board-error"
import { withBoardBudget } from "@/lib/insights/board-page-fetch"
import { fetchPinnacleReality } from "@/lib/insights/pinnacle-pack-reality-board"

export async function GET() {
  const startedAt = Date.now()
  let payload
  try {
    payload = await withBoardBudget(fetchPinnacleReality(supabase), "pinnacle-pack-reality")
  } catch (e) {
    return boardUnavailable(e, "insights/pinnacle-pack-reality")
  }
  const res = NextResponse.json({
    meta: {
      fetched_at: new Date().toISOString(),
      source: "get_pinnacle_pack_reality",
      elapsed_ms: Date.now() - startedAt,
      since: payload.since,
      min_opens: payload.min_opens,
      drops: payload.drops.length,
    },
    rows: payload.drops,
  })
  res.headers.set("Cache-Control", "public, s-maxage=1800, stale-while-revalidate=300")
  return res
}

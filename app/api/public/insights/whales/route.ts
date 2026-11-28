// app/api/public/insights/whales/route.ts
//
// PUBLIC INSIGHTS — Whale Watch. Who is spending big across every collection we
// track: the biggest spenders (7d / 30d), their latest big buys, and the month's
// biggest purchases. Backs /insights/whales. Under /api/public/* so proxy.ts lets
// anon through.
//
// Reads ONE precomputed row (public.whale_watch_board, refreshed hourly by pg_cron
// rpc-whale-watch-board) through the service role, via lib/whale-watch-board.ts —
// the same fetcher the server page uses, so the API and the page never diverge. A
// failed read or a missing snapshot is a 503 (boardUnavailable), never an empty
// board: "no whales" is a market claim.

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin as supabase } from "@/lib/supabase"
import { boardUnavailable } from "@/lib/insights/board-error"
import { fetchWhaleWatchBoard } from "@/lib/whale-watch-board"

export async function GET(_req: NextRequest) {
  const startedAt = Date.now()
  try {
    const board = await fetchWhaleWatchBoard(supabase)
    const res = NextResponse.json({
      meta: {
        fetched_at: new Date().toISOString(),
        computed_at: board.computed_at,
        source: "whale_watch_board",
        elapsed_ms: Date.now() - startedAt,
      },
      ...board,
    })
    // The snapshot is rewritten hourly; the edge cache bounds an OG-share spike.
    res.headers.set("Cache-Control", "public, s-maxage=900, stale-while-revalidate=1800")
    return res
  } catch (e) {
    return boardUnavailable(e, "insights/whales")
  }
}

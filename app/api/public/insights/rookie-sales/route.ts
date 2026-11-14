// app/api/public/insights/rookie-sales/route.ts
//
// PUBLIC INSIGHTS — the 2026 NBA rookie class on Top Shot ranked by marketplace sales SINCE
// RELEASE across every edition, with each rookie's 2026 draft pick, season per-game line and a
// standard Rookie Debut moment id for imagery. Backs the @RipPacksCity Wednesday rookie post
// (scripts/social/x-draft.mjs + x-image.mjs). Definitions: lib/insights/rookie-sales.ts.
//
//   GET /api/public/insights/rookie-sales?class=2026&limit=<1..100>   (default limit 100)
//
// Only class=2026 exists; any other class is a 400, never a silent 2026 answer. A failed or
// partial read is a 5xx (boardUnavailable), never an empty or undercounted board.
//
// CACHE: 5-minute s-maxage, like the rookies board.

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { boardUnavailable } from "@/lib/insights/board-error"
import { fetchRookieSales2026 } from "@/lib/insights/rookie-sales"

export const dynamic = "force-dynamic"

export async function GET(req: NextRequest) {
  const startedAt = Date.now()
  const url = new URL(req.url)
  const cohortClass = url.searchParams.get("class") ?? "2026"
  if (cohortClass !== "2026") {
    return NextResponse.json({ error: "class must be 2026" }, { status: 400 })
  }
  const limitRaw = Number(url.searchParams.get("limit") ?? "100")
  const limit = Math.max(1, Math.min(100, Number.isFinite(limitRaw) ? Math.trunc(limitRaw) : 100))

  let board
  try {
    board = await fetchRookieSales2026(supabaseAdmin)
  } catch (e) {
    return boardUnavailable(e, "insights/rookie-sales")
  }

  const res = NextResponse.json({
    meta: {
      fetched_at: new Date().toISOString(),
      elapsed_ms: Date.now() - startedAt,
      filters: { class: cohortClass, limit },
      window: "since release (all marketplace sales, every edition)",
      latest_sale_at: board.latest_sale_at,
      stats_season: board.stats_season,
      stats_through: board.stats_through,
    },
    totals: board.totals,
    rows: board.rows.slice(0, limit),
  })
  res.headers.set("Cache-Control", "public, s-maxage=300, stale-while-revalidate=60")
  return res
}

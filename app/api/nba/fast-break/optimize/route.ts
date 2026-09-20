// app/api/nba/fast-break/optimize/route.ts
//
// Public Fast Break optimizer endpoint. Forwards to the SECDEF
// optimize_fast_break_lineup(run_id, game_date) RPC. Defaults:
//   • run_id  → currently active fast_break_runs row
//   • game_date → today in America/New_York (Top Shot Fast Break is Eastern)
//
// Cache: public, max-age=900 (15 min).
//
// ⚠ THIS COMMENT USED TO READ "Projections sync every 2h so 15 min is
// comfortably fresh for the live slate." THAT PREMISE HAS BEEN FALSE SINCE
// 2026-08-04. `sync-nba-projections` has failed 100% of its runs since then
// (`all_upstreams_failed`, downstream of the operator-gated sports-proxy 403 —
// register #8), and `nba_player_projections` last advanced 2026-07-20 —
// 61 days stale when re-measured 2026-09-19.
//
// The TTL is left at 15 min deliberately: it is harmless either way, and
// lowering it would only re-fetch the same frozen rows more often. What is
// corrected is the STATED REASON, because the next reader would otherwise size
// a cache on a sync cadence that no longer exists.
//
// ✅ The payload itself is honest about the drought — it carries
// `eligible_players_pool_size` (0 in the offseason) and the run's own
// start/end dates, and the client renders "0 eligible projections in pool"
// rather than an empty lineup with no explanation.

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { apiErrorResponse } from "@/lib/api-error"
import { boundedRead } from "@/lib/api/bounded-read"

export const dynamic = "force-dynamic"

function todayEastern(): string {
  // YYYY-MM-DD in America/New_York. Intl.DateTimeFormat with en-CA emits
  // exactly that shape ("2026-05-11"), letting us skip manual padding.
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
  return fmt.format(new Date())
}

function isValidDate(s: string | null): s is string {
  if (!s) return false
  return /^\d{4}-\d{2}-\d{2}$/.test(s)
}

const CACHE_HEADERS = {
  "cache-control": "public, max-age=900, s-maxage=900, stale-while-revalidate=600",
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  let runId = url.searchParams.get("run_id")
  const gameDateRaw = url.searchParams.get("game_date")
  const gameDate = isValidDate(gameDateRaw) ? gameDateRaw : todayEastern()
  const asOf = new Date().toISOString()

  if (!runId) {
    const { data: active, error: runErr } = await boundedRead((supabaseAdmin as any)
      .from("fast_break_runs")
      .select("id, name, start_date, end_date, lineup_size, has_captain")
      .eq("is_active", true)
      .order("start_date", { ascending: false })
      .limit(1)
      .maybeSingle(), "api/nba/fast-break/optimize/fast_break_runs")

    if (runErr) {
      return apiErrorResponse(runErr, "api/nba/fast-break/optimize")
    }
    if (!active) {
      return NextResponse.json(
        {
          recommended_score: 0,
          lineup: [],
          meta: { game_date: gameDate, no_active_run: true },
          as_of: asOf,
        },
        { status: 200, headers: CACHE_HEADERS }
      )
    }
    runId = active.id as string
  }

  const { data, error } = await boundedRead((supabaseAdmin as any).rpc(
    "optimize_fast_break_lineup",
    { p_run_id: runId, p_game_date: gameDate }
  ), "api/nba/fast-break/optimize/optimize_fast_break_lineup")
  if (error) {
    return apiErrorResponse(error, "api/nba/fast-break/optimize")
  }

  return NextResponse.json(
    {
      ...(data ?? {}),
      as_of: asOf,
    },
    { headers: CACHE_HEADERS }
  )
}

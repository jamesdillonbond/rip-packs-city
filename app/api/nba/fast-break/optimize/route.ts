// app/api/nba/fast-break/optimize/route.ts
//
// Public Fast Break optimizer endpoint. Forwards to the SECDEF
// optimize_fast_break_lineup(run_id, game_date) RPC. Defaults:
//   • run_id  → currently active fast_break_runs row
//   • game_date → today in America/New_York (Top Shot Fast Break is Eastern)
//
// Cache: public, max-age=900 (15 min). Projections sync every 2h so 15 min
// is comfortably fresh for the live slate.

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"

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
    const { data: active, error: runErr } = await (supabaseAdmin as any)
      .from("fast_break_runs")
      .select("id, name, start_date, end_date, lineup_size, has_captain")
      .eq("is_active", true)
      .order("start_date", { ascending: false })
      .limit(1)
      .maybeSingle()

    if (runErr) {
      return NextResponse.json(
        { error: runErr.message },
        { status: 500 }
      )
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

  const { data, error } = await (supabaseAdmin as any).rpc(
    "optimize_fast_break_lineup",
    { p_run_id: runId, p_game_date: gameDate }
  )
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json(
    {
      ...(data ?? {}),
      as_of: asOf,
    },
    { headers: CACHE_HEADERS }
  )
}

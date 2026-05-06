// app/api/fast-break/today/route.ts
//
// Reads the active Fast Break run plus today's NBA slate (games + DraftKings
// projections). No auth — the run + slate are public surface and the optimizer
// page calls this without a wallet attached.

import { NextResponse } from "next/server"
import { supabaseAdmin as supabase } from "@/lib/supabase"

export const dynamic = "force-dynamic"

const ROUTE_HEADERS: Record<string, string> = { "X-RPC-Route": "fast-break-today" }

function todayInET(): string {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
  const parts = Object.fromEntries(fmt.formatToParts(new Date()).map(p => [p.type, p.value]))
  return `${parts.year}-${parts.month}-${parts.day}`
}

export async function GET() {
  try {
    const { data: run, error: runErr } = await supabase
      .from("fast_break_runs")
      .select("id, name, lineup_size, has_captain, start_date, end_date")
      .eq("is_active", true)
      .maybeSingle()

    if (runErr) {
      console.error("[fast-break-today] run lookup:", runErr.message)
      return NextResponse.json({ error: "internal_error", detail: runErr.message }, { status: 500, headers: ROUTE_HEADERS })
    }
    if (!run) {
      return NextResponse.json(
        { runId: null, message: "no_active_run" },
        { headers: ROUTE_HEADERS },
      )
    }

    const gameDate = todayInET()

    const { data: games, error: gamesErr } = await supabase
      .from("nba_games")
      .select("id, external_game_id, game_date, home_team_abbr, away_team_abbr, tipoff_at, status")
      .eq("game_date", gameDate)
      .order("tipoff_at", { ascending: true })

    if (gamesErr) {
      console.error("[fast-break-today] games lookup:", gamesErr.message)
      return NextResponse.json({ error: "internal_error", detail: gamesErr.message }, { status: 500, headers: ROUTE_HEADERS })
    }

    const baseRunPayload = {
      runId: run.id,
      runName: run.name,
      lineupSize: run.lineup_size,
      hasCaptain: run.has_captain,
      gameDate,
    }

    if (!games || games.length === 0) {
      return NextResponse.json(
        { ...baseRunPayload, games: [], projections: [], message: "no_games_today" },
        { headers: ROUTE_HEADERS },
      )
    }

    const gameIds = games.map(g => g.id)

    const { data: projRows, error: projErr } = await supabase
      .from("nba_player_projections")
      .select("nba_player_id, game_id, proj_fp_dk, proj_minutes, injury_status")
      .in("game_id", gameIds)
      .eq("game_date", gameDate)
      .eq("source", "draftkings")

    if (projErr) {
      console.error("[fast-break-today] projections lookup:", projErr.message)
      return NextResponse.json({ error: "internal_error", detail: projErr.message }, { status: 500, headers: ROUTE_HEADERS })
    }

    const playerIds = Array.from(new Set((projRows ?? []).map(r => r.nba_player_id)))
    const playerMetaMap = new Map<string, { full_name: string; current_team_abbr: string | null; position: string | null }>()
    if (playerIds.length > 0) {
      const { data: playerRows } = await supabase
        .from("nba_players")
        .select("id, full_name, current_team_abbr, position")
        .in("id", playerIds)
      for (const r of playerRows ?? []) {
        playerMetaMap.set(r.id, {
          full_name: r.full_name,
          current_team_abbr: r.current_team_abbr,
          position: r.position,
        })
      }
    }

    const gameLookup = new Map(games.map(g => [g.id, g]))

    const projections = (projRows ?? []).map(r => {
      const meta = playerMetaMap.get(r.nba_player_id)
      const game = gameLookup.get(r.game_id)
      let opponentTeam: string | null = null
      const teamAbbr = meta?.current_team_abbr ?? null
      if (game && teamAbbr) {
        if (game.home_team_abbr === teamAbbr) opponentTeam = game.away_team_abbr
        else if (game.away_team_abbr === teamAbbr) opponentTeam = game.home_team_abbr
      }
      return {
        nbaPlayerId: r.nba_player_id,
        fullName: meta?.full_name ?? null,
        teamAbbr,
        gameId: r.game_id,
        opponentTeam,
        projFp: r.proj_fp_dk == null ? null : Number(r.proj_fp_dk),
        injuryStatus: r.injury_status,
        position: meta?.position ?? null,
      }
    })

    return NextResponse.json(
      {
        ...baseRunPayload,
        games: games.map(g => ({
          gameId: g.id,
          externalGameId: g.external_game_id,
          homeTeam: g.home_team_abbr,
          awayTeam: g.away_team_abbr,
          tipoffAt: g.tipoff_at,
          status: g.status,
        })),
        projections,
      },
      { headers: ROUTE_HEADERS },
    )
  } catch (err: any) {
    console.error("[fast-break-today]", err?.message ?? err)
    return NextResponse.json(
      { error: "internal_error", detail: err?.message ?? String(err) },
      { status: 500, headers: ROUTE_HEADERS },
    )
  }
}

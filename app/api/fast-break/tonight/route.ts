// app/api/fast-break/tonight/route.ts
//
// Regular-season Fast Break (2026-27): tonight's stat targets, and the five players
// plus Captain from THIS wallet most likely to clear them. Runs whose objective is
// 'thresholds' use this route; playoff runs ('max_points') keep /api/fast-break/optimize.
//
// Reads, all service-role:
//   fast_break_runs            the run (lineup size, captain)
//   fast_break_nights          tonight's targets for that run — recorded by hand from
//                              nbatopshot.com/fastbreak; a night with no row is
//                              `targets_unknown`, never "no targets"
//   get_fb_eligible_players_v3 the wallet's players and THIS user's uses left this run
//                              (higher of Top Shot ASP band and tier, 2026-27 rule)
//   nba_games + nba_player_projections  tonight's slate and the blended projections
//
// Three states, never two (CLAUDE.md honesty rules): every failed read is a 500 with
// a named error; an empty answer is only returned when every read succeeded.

import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { supabaseAdmin as supabase } from "@/lib/supabase"
import { requireUser } from "@/lib/auth/supabase-server"
import { nbaFeedAnsweredRecently } from "@/lib/fast-break/nba-feed"
import {
  buildThresholdLineup,
  coverageScore,
  isAvailable,
  lineupOutlook,
  type StatKey,
  type Targets,
  type ThresholdPlayer,
} from "@/lib/fast-break/threshold-optimizer"

export const dynamic = "force-dynamic"

const ROUTE_HEADERS: Record<string, string> = { "X-RPC-Route": "fast-break-tonight" }

const bodySchema = z.object({
  walletAddr: z.string().regex(/^0x[a-f0-9]{16}$/i, "walletAddr must be a 0x + 16 hex Flow address"),
  runId: z.string().uuid(),
  gameDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
})

function todayInET(now: Date = new Date()): string {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
  const parts = Object.fromEntries(fmt.formatToParts(now).map(p => [p.type, p.value]))
  return `${parts.year}-${parts.month}-${parts.day}`
}

/** Projection column for each target stat. */
const PROJ_COLUMN: Record<StatKey, string> = {
  pts: "proj_points", reb: "proj_rebounds", ast: "proj_assists", stl: "proj_steals",
  blk: "proj_blocks", tov: "proj_turnovers", fg3m: "proj_threes", fg3a: "proj_three_attempts",
  fgm: "proj_fgm", fga: "proj_fga", ftm: "proj_ftm", fta: "proj_fta",
}

function fail(error: string, status = 500) {
  return NextResponse.json({ error }, { status, headers: ROUTE_HEADERS })
}

export async function POST(req: NextRequest) {
  // Uses left are per COLLECTOR (fast_break_player_uses.user_id), so the caller must be known.
  let user
  try {
    user = await requireUser()
  } catch (res) {
    return res as Response
  }

  let raw: unknown
  try {
    raw = await req.json()
  } catch {
    return fail("malformed_json", 400)
  }
  const parsed = bodySchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_body", detail: parsed.error.format() },
      { status: 400, headers: ROUTE_HEADERS },
    )
  }
  const { runId } = parsed.data
  const walletAddr = parsed.data.walletAddr.toLowerCase()
  const gameDate = parsed.data.gameDate ?? todayInET()

  try {
    const { data: run, error: runErr } = await supabase
      .from("fast_break_runs")
      .select("id, name, lineup_size, has_captain, start_date, end_date, objective")
      .eq("id", runId)
      .maybeSingle()
    if (runErr) {
      console.error("[fast-break-tonight] run:", runErr.message)
      return fail("run_lookup_failed")
    }
    if (!run) return fail("run_not_found", 404)

    const { data: night, error: nightErr } = await supabase
      .from("fast_break_nights")
      .select("objective, targets")
      .eq("run_id", runId)
      .eq("game_date", gameDate)
      .maybeSingle()
    if (nightErr) {
      console.error("[fast-break-tonight] night:", nightErr.message)
      return fail("targets_lookup_failed")
    }

    const { data: games, error: gamesErr } = await supabase
      .from("nba_games")
      .select("id, home_team_abbr, away_team_abbr, tipoff_at, status")
      .eq("game_date", gameDate)
    if (gamesErr) {
      console.error("[fast-break-tonight] games:", gamesErr.message)
      return fail("games_lookup_failed")
    }
    const gameIds = (games ?? []).map(g => g.id as string)
    const gameById = new Map((games ?? []).map(g => [g.id as string, g]))

    const targets: Targets = (night?.targets as Targets | undefined) ?? {}
    const statCols = Array.from(new Set((Object.keys(targets) as StatKey[]).map(k => PROJ_COLUMN[k]).filter(Boolean)))

    let projRows: any[] = []
    if (gameIds.length > 0) {
      const { data, error: projErr } = await supabase
        .from("nba_player_projections")
        .select(["nba_player_id", "game_id", "injury_status", "projection_method", ...statCols].join(", "))
        .in("game_id", gameIds)
        .eq("game_date", gameDate)
        .not("proj_fp_dk", "is", null)
      if (projErr) {
        console.error("[fast-break-tonight] projections:", projErr.message)
        return fail("projections_lookup_failed")
      }
      projRows = data ?? []
    }
    const projByPlayer = new Map<string, any>(projRows.map(r => [r.nba_player_id, r]))

    const { data: eligibleRaw, error: eligErr } = await (supabase as any).rpc(
      "get_fb_eligible_players_v3",
      { p_wallet_addr: walletAddr, p_run_id: runId, p_user_id: user.id },
    )
    if (eligErr) {
      console.error("[fast-break-tonight] get_fb_eligible_players_v3:", eligErr.message)
      return fail("eligible_rpc_failed")
    }
    const eligible = (eligibleRaw ?? []) as any[]

    const runLiveToday = run.start_date <= gameDate && gameDate <= run.end_date
    let feedAnsweredRecently = true
    if (gameIds.length === 0 && runLiveToday) {
      feedAnsweredRecently = await nbaFeedAnsweredRecently(supabase, "[fast-break-tonight]")
    }
    const dataStatus: "ok" | "no_games" | "slate_unavailable" | "projections_unavailable" | "targets_unknown" =
      gameIds.length === 0
        ? runLiveToday && !feedAnsweredRecently ? "slate_unavailable" : "no_games"
        : projRows.length === 0
          ? "projections_unavailable"
          : !night
            ? "targets_unknown"
            : "ok"

    const toPlayer = (e: any, proj: any): ThresholdPlayer => {
      const game = gameById.get(proj.game_id)
      const team = e.current_team_abbr ?? ""
      const opponent = game
        ? game.home_team_abbr === team ? game.away_team_abbr : game.away_team_abbr === team ? game.home_team_abbr : ""
        : ""
      const projStats: Partial<Record<StatKey, number>> = {}
      for (const k of Object.keys(targets) as StatKey[]) {
        const v = proj[PROJ_COLUMN[k]]
        if (v != null) projStats[k] = Number(v)
      }
      return {
        nbaPlayerId: e.nba_player_id,
        fullName: e.full_name,
        teamAbbr: team,
        proj: projStats,
        injuryStatus: proj.injury_status ?? null,
        remainingUses: e.remaining_uses == null ? null : Number(e.remaining_uses),
        totalUses: e.total_allowed == null ? null : Number(e.total_allowed),
        highestTier: e.highest_tier ?? "COMMON",
        bestMomentId: e.best_moment_id ?? "",
        bestSerial: Number(e.best_serial ?? 0),
        gameId: proj.game_id,
        opponentTeamAbbr: opponent,
      }
    }

    const onSlate: ThresholdPlayer[] = []
    for (const e of eligible) {
      const proj = projByPlayer.get(e.nba_player_id)
      if (proj) onSlate.push(toPlayer(e, proj))
    }

    const lineupSize = Number(run.lineup_size) || 5
    const lineup = dataStatus === "ok"
      ? buildThresholdLineup(onSlate, targets, { lineupSize, hasCaptain: !!run.has_captain })
      : null

    // The same night with no ownership limit: what the best possible lineup's odds are,
    // and which of its players this wallet lacks or has no plays left for.
    let slateBest: { winProbability: number; missing: Array<{ nbaPlayerId: string; fullName: string | null; teamAbbr: string | null; reason: "not_owned" | "no_uses_left" }> } | null = null
    if (dataStatus === "ok") {
      const ownedById = new Map(onSlate.map(p => [p.nbaPlayerId, p]))
      const everyone: ThresholdPlayer[] = projRows.map(r => {
        const owned = ownedById.get(r.nba_player_id)
        const stub = owned ?? toPlayer({ nba_player_id: r.nba_player_id, full_name: r.nba_player_id, current_team_abbr: "", remaining_uses: null }, r)
        return { ...stub, remainingUses: null }
      })
      const best = buildThresholdLineup(everyone, targets, { lineupSize, hasCaptain: !!run.has_captain })
      if (best) {
        const missingIds = best.players
          .filter(p => { const o = ownedById.get(p.nbaPlayerId); return !o || !isAvailable(o) })
          .map(p => p.nbaPlayerId)
        let names = new Map<string, { full_name: string; current_team_abbr: string | null }>()
        if (missingIds.length) {
          const { data: meta, error: metaErr } = await supabase
            .from("nba_players")
            .select("id, full_name, current_team_abbr")
            .in("id", missingIds)
          if (metaErr) console.error("[fast-break-tonight] missing meta:", metaErr.message)
          names = new Map((meta ?? []).map(m => [m.id as string, m as any]))
        }
        slateBest = {
          winProbability: best.winProbability,
          missing: missingIds.map(id => ({
            nbaPlayerId: id,
            fullName: names.get(id)?.full_name ?? null,
            teamAbbr: names.get(id)?.current_team_abbr ?? null,
            reason: ownedById.has(id) ? "no_uses_left" : "not_owned",
          })),
        }
      }
    }

    // Top options per target, from this wallet's available players, for manual building.
    const options = dataStatus === "ok"
      ? onSlate
          .filter(isAvailable)
          .sort((a, b) => coverageScore(b, targets) - coverageScore(a, targets))
          .slice(0, 15)
      : []

    return NextResponse.json(
      {
        walletAddr,
        runId,
        runName: run.name,
        gameDate,
        dataStatus,
        objective: night?.objective ?? null,
        targets,
        lineupSize,
        hasCaptain: !!run.has_captain,
        eligibleCount: eligible.length,
        onSlateCount: onSlate.length,
        lineup,
        slateBest,
        options: options.map(p => ({ ...p, outlookAlone: lineupOutlook([p], null, targets).targets })),
      },
      { headers: ROUTE_HEADERS },
    )
  } catch (err: any) {
    console.error("[fast-break-tonight]", err?.message ?? err)
    return fail("internal_error")
  }
}

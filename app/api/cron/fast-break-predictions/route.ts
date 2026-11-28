// app/api/cron/fast-break-predictions/route.ts
//
// Fast Break track record (2026-11-28). Hourly (vercel.json). Two halves:
//   1. SCORE every stored prediction for a past night whose games are all final with box
//      scores in (nba_player_game_stats) — lib/fast-break/track-record.ts scorePrediction.
//   2. PREDICT tonight for each active `thresholds` run: the model's best lineup from the whole
//      slate (no ownership limit) and its chance of clearing every target, stored in
//      fast_break_predictions. Re-written each hour until the first tipoff, never after — the
//      projection blend folds finished games into the season line, so a later write would leak
//      the answer.
// Auth: Bearer CRON_SECRET (Vercel cron) or INGEST_SECRET_TOKEN. Writes one terminal
// pipeline_runs row ('fast-break-predictions') on every exit past auth; `ok` is derived from
// whether every read and write landed, and each count is rows actually written.

import { NextRequest, NextResponse } from "next/server"
import { bearerMatches } from "@/lib/auth/bearer-secret"
import { supabaseAdmin } from "@/lib/supabase"
import { logTerminalRun } from "@/lib/pipeline/terminal-run"
import { buildThresholdLineup, type StatKey, type Targets, type ThresholdPlayer } from "@/lib/fast-break/threshold-optimizer"
import { PROJ_COLUMN, scorePrediction, type BoxLine, type GameState, type PredictedPick } from "@/lib/fast-break/track-record"

export const dynamic = "force-dynamic"
export const maxDuration = 60

const PIPELINE = "fast-break-predictions"
const STATS: StatKey[] = ["pts", "reb", "ast", "stl", "blk", "tov", "fgm", "fga", "fg3m", "fg3a", "ftm", "fta"]

function todayInET(now: Date): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" })
      .formatToParts(now)
      .map(p => [p.type, p.value]),
  )
  return `${parts.year}-${parts.month}-${parts.day}`
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any

async function scorePending(db: Db, today: string, errors: string[]): Promise<{ scored: number; pending: number }> {
  const { data: rows, error } = await db
    .from("fast_break_predictions")
    .select("run_id, game_date, kind, targets, players")
    .is("cleared", null)
    .lt("game_date", today)
  if (error) { errors.push(`predictions_read: ${error.message}`); return { scored: 0, pending: 0 } }
  let scored = 0
  let pending = 0
  for (const row of rows ?? []) {
    const picks = (row.players ?? []) as PredictedPick[]
    const gameIds = Array.from(new Set(picks.map(p => p.gameId)))
    const { data: games, error: gErr } = await db.from("nba_games").select("id, status").in("id", gameIds)
    if (gErr) { errors.push(`games_read: ${gErr.message}`); continue }
    const { data: boxRows, error: bErr } = await db
      .from("nba_player_game_stats")
      .select(["game_id", "nba_player_id", "did_play", ...STATS].join(", "))
      .in("game_id", gameIds)
    if (bErr) { errors.push(`box_read: ${bErr.message}`); continue }
    const withBox = new Set((boxRows ?? []).map((b: any) => b.game_id as string))
    const gameState = new Map<string, GameState>(
      (games ?? []).map((g: any) => [g.id as string, { final: String(g.status) === "final", hasBoxRows: withBox.has(g.id) }]),
    )
    const box = new Map<string, BoxLine>()
    for (const b of (boxRows ?? []) as any[]) {
      if (!b.nba_player_id) continue
      const line: BoxLine = { didPlay: b.did_play === true }
      for (const s of STATS) line[s] = b[s] == null ? null : Number(b[s])
      box.set(b.nba_player_id, line)
    }
    const result = scorePrediction(picks, row.targets as Targets, box, gameState)
    if (result.state === "pending") { pending++; continue }
    const { error: uErr } = await db
      .from("fast_break_predictions")
      .update({
        cleared: result.cleared,
        actual: { totals: result.totals, used: result.used, benchUsed: result.benchUsed },
        scored_at: new Date().toISOString(),
      })
      .eq("run_id", row.run_id)
      .eq("game_date", row.game_date)
      .eq("kind", row.kind)
    if (uErr) { errors.push(`score_write: ${uErr.message}`); continue }
    scored++
  }
  return { scored, pending }
}

async function predictTonight(db: Db, today: string, now: Date, errors: string[]): Promise<{ written: number; locked: number; skipped: number }> {
  let written = 0
  let skipped = 0
  const locked = 0
  const { data: runs, error: rErr } = await db
    .from("fast_break_runs")
    .select("id, lineup_size, has_captain, start_date, end_date")
    .eq("is_active", true)
    .eq("objective", "thresholds")
  if (rErr) { errors.push(`runs_read: ${rErr.message}`); return { written, locked, skipped } }
  const live = (runs ?? []).filter((r: any) => r.start_date <= today && today <= r.end_date)
  if (!live.length) return { written, locked, skipped }

  const { data: games, error: gErr } = await db
    .from("nba_games")
    .select("id, home_team_abbr, away_team_abbr, tipoff_at")
    .eq("game_date", today)
  if (gErr) { errors.push(`games_read: ${gErr.message}`); return { written, locked, skipped } }
  if (!games?.length) return { written, locked, skipped: live.length }
  const tipoffs = games.map((g: any) => g.tipoff_at).filter(Boolean).map((t: string) => Date.parse(t))
  const firstTipoff = tipoffs.length ? new Date(Math.min(...tipoffs)) : null
  if (firstTipoff && now >= firstTipoff) return { written, locked: live.length, skipped }

  const gameIds = games.map((g: any) => g.id as string)
  const { data: proj, error: pErr } = await db
    .from("nba_player_projections")
    .select(["nba_player_id", "game_id", "injury_status", ...Object.values(PROJ_COLUMN)].join(", "))
    .in("game_id", gameIds)
    .eq("game_date", today)
    .not("proj_fp_dk", "is", null)
  if (pErr) { errors.push(`projections_read: ${pErr.message}`); return { written, locked, skipped } }
  if (!proj?.length) return { written, locked, skipped: live.length }

  const ids = Array.from(new Set((proj as any[]).map(p => p.nba_player_id as string)))
  const { data: meta, error: mErr } = await db.from("nba_players").select("id, full_name, current_team_abbr").in("id", ids)
  if (mErr) { errors.push(`players_read: ${mErr.message}`); return { written, locked, skipped } }
  const metaById = new Map((meta ?? []).map((m: any) => [m.id as string, m]))

  for (const run of live) {
    const { data: night, error: nErr } = await db
      .from("fast_break_nights")
      .select("objective, targets")
      .eq("run_id", run.id)
      .eq("game_date", today)
      .maybeSingle()
    if (nErr) { errors.push(`night_read: ${nErr.message}`); continue }
    const targets = (night?.targets ?? {}) as Targets
    if (!night || Object.keys(targets).length === 0) { skipped++; continue }

    // Without a known first tipoff, write once and never overwrite (cannot tell when it locks).
    if (!firstTipoff) {
      const { data: existing, error: eErr } = await db
        .from("fast_break_predictions").select("run_id").eq("run_id", run.id).eq("game_date", today).eq("kind", "slate_best").maybeSingle()
      if (eErr) { errors.push(`existing_read: ${eErr.message}`); continue }
      if (existing) { skipped++; continue }
    }

    const players: ThresholdPlayer[] = (proj as any[]).map(r => {
      const m: any = metaById.get(r.nba_player_id)
      const projStats: Partial<Record<StatKey, number>> = {}
      for (const k of Object.keys(targets) as StatKey[]) {
        const v = r[PROJ_COLUMN[k]]
        if (v != null) projStats[k] = Number(v)
      }
      return {
        nbaPlayerId: r.nba_player_id, fullName: m?.full_name ?? r.nba_player_id, teamAbbr: m?.current_team_abbr ?? "",
        proj: projStats, injuryStatus: r.injury_status ?? null, remainingUses: null, totalUses: null,
        highestTier: "COMMON", bestMomentId: "", bestSerial: 0, gameId: r.game_id, opponentTeamAbbr: "",
      }
    })
    const lineup = buildThresholdLineup(players, targets, { lineupSize: Number(run.lineup_size) || 5, hasCaptain: !!run.has_captain })
    if (!lineup) { skipped++; continue }
    const pick = (p: ThresholdPlayer, bench: boolean): PredictedPick => ({
      id: p.nbaPlayerId, name: metaById.has(p.nbaPlayerId) ? p.fullName : null, team: p.teamAbbr || null,
      gameId: p.gameId, captain: !bench && p.nbaPlayerId === lineup.captainNbaPlayerId, bench,
    })
    const picks = [...lineup.players.map(p => pick(p, false)), ...(lineup.bench ? [pick(lineup.bench, true)] : [])]
    const { error: wErr } = await db.from("fast_break_predictions").upsert(
      {
        run_id: run.id, game_date: today, kind: "slate_best", objective: night.objective, targets,
        players: picks, predicted_p: lineup.winProbability,
        per_target: lineup.targets.map(t => ({ stat: t.stat, target: t.target, projected: t.projected, probability: t.probability })),
        first_tipoff_at: firstTipoff?.toISOString() ?? null, predicted_at: now.toISOString(),
      },
      { onConflict: "run_id,game_date,kind" },
    )
    if (wErr) { errors.push(`prediction_write: ${wErr.message}`); continue }
    written++
  }
  return { written, locked, skipped }
}

export async function GET(req: NextRequest) {
  if (!bearerMatches(req.headers.get("authorization"), "CRON_SECRET", "INGEST_SECRET_TOKEN")) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 })
  }
  const startedAt = new Date()
  const today = todayInET(startedAt)
  const errors: string[] = []
  let score = { scored: 0, pending: 0 }
  let predict = { written: 0, locked: 0, skipped: 0 }
  try {
    score = await scorePending(supabaseAdmin, today, errors)
    predict = await predictTonight(supabaseAdmin, today, startedAt, errors)
  } catch (err) {
    errors.push(`internal: ${err instanceof Error ? err.message : String(err)}`)
  }
  const ok = errors.length === 0
  await logTerminalRun({
    pipeline: PIPELINE,
    startedAt,
    ok,
    error: ok ? null : errors.join("; ").slice(0, 1000),
    rowsWritten: score.scored + predict.written,
    extra: { today, scored: score.scored, still_pending: score.pending, predicted: predict.written, locked: predict.locked, skipped: predict.skipped, errors: errors.length },
  })
  return NextResponse.json({ ok, today, ...score, ...predict, errors }, { status: ok ? 200 : 500 })
}

export async function POST(req: NextRequest) {
  return GET(req)
}

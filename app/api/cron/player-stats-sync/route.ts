import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { writeInvocationHeartbeat } from "@/lib/pipeline/heartbeat"
import { logTerminalRun } from "@/lib/pipeline/terminal-run"

// ─────────────────────────────────────────────────────────────────────────────
// player-stats-sync — the DB half of the ESPN-fed player stats feed (batch 47,
// 2026-09-25). The ESPN fetch CANNOT live here with certainty: ESPN's public
// JSON 403s from Supabase edge (measured 2026-08-09, #8) and is unmeasured from
// Vercel, while it answers 200 from a GitHub Actions runner. So the runner
// (scripts/sync-player-stats.mjs) fetches ESPN and talks to THIS route for
// every read and write, under the existing INGEST token — the Atlas pattern.
//
// Runner protocol:
//   GET  ?phase=targets&league=nfl|nba&limit=N
//        -> { targets:[{identity_id, espn_id, display_name, stats_refreshed_at}] }
//        (writes the -heartbeat row: the runner's invocation is then knowable
//        even when the job is killed before its final POST)
//   GET  ?phase=espn-resolve-targets&league=nba&limit=N
//        -> { targets:[{identity_id, display_name, name_slug}] }
//   POST { league, espn_ids:[{identity_id, espn_id|null, matched_by}] }
//        -> { updated }  (writes an espn_id only where NULL; provenance kept)
//   POST { league, rows:[…stat lines…], touched:[espn_id…] }
//        -> { upserted }  (rows_written is what the RPC RETURNED)
//   POST { final:true, league, startedAt, stats:{…} }
//        -> terminal pipeline_runs row: ok is DERIVED from the runner's counts
//           (every chunk landed, nothing exploded), never asserted
//
// Auth: Bearer INGEST_SECRET_TOKEN (or CRON_SECRET). Methods: GET, POST.
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic"
export const maxDuration = 60

const PIPELINE = "player-stats-sync"
const LEAGUES = new Set(["nfl", "nba"])

function authed(req: NextRequest): boolean {
  const auth = req.headers.get("authorization")
  if (process.env.INGEST_SECRET_TOKEN && auth === `Bearer ${process.env.INGEST_SECRET_TOKEN}`) return true
  if (process.env.CRON_SECRET && auth === `Bearer ${process.env.CRON_SECRET}`) return true
  return false
}

function leagueOf(v: string | null | undefined): string | null {
  const l = (v ?? "").toLowerCase()
  return LEAGUES.has(l) ? l : null
}

function limitOf(raw: string | null, dflt: number): number {
  if (raw == null || raw === "") return dflt
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? Math.min(n, 2000) : dflt
}

export async function GET(req: NextRequest) {
  if (!authed(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const phase = req.nextUrl.searchParams.get("phase")
  const league = leagueOf(req.nextUrl.searchParams.get("league"))
  if (!league) return NextResponse.json({ error: "league must be nfl or nba" }, { status: 400 })

  if (phase === "targets") {
    const limit = limitOf(req.nextUrl.searchParams.get("limit"), 300)
    await writeInvocationHeartbeat({ pipeline: PIPELINE, startedAtMs: Date.now(), extra: { league, limit } })
    const { data, error } = await supabaseAdmin.rpc("player_stats_sync_targets", { p_league: league, p_limit: limit })
    if (error) return NextResponse.json({ error: `targets: ${error.message}` }, { status: 500 })
    const targets = (data as unknown[]) ?? []
    return NextResponse.json({ league, count: targets.length, targets }, { status: 200 })
  }
  if (phase === "espn-resolve-targets") {
    const limit = limitOf(req.nextUrl.searchParams.get("limit"), 200)
    const { data, error } = await supabaseAdmin.rpc("player_stats_espn_resolve_targets", { p_league: league, p_limit: limit })
    if (error) return NextResponse.json({ error: `resolve targets: ${error.message}` }, { status: 500 })
    const targets = (data as unknown[]) ?? []
    return NextResponse.json({ league, count: targets.length, targets }, { status: 200 })
  }
  return NextResponse.json({ error: "unknown phase (targets | espn-resolve-targets)" }, { status: 400 })
}

type FinalStats = {
  targets?: number
  fetched_ok?: number
  fetched_404?: number
  fetched_failed?: number
  rows_upserted?: number
  chunks?: number
  chunks_ok?: number
  resolve_targets?: number
  resolved?: number
  unresolved?: number
  resolve_failed?: number
  deadline_hit?: boolean
  errors?: unknown
  runner_event?: string
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null
}

export async function POST(req: NextRequest) {
  if (!authed(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  let body: Record<string, unknown>
  try {
    body = (await req.json()) as Record<string, unknown>
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 })
  }
  const league = leagueOf(typeof body.league === "string" ? body.league : null)
  if (!league) return NextResponse.json({ error: "league must be nfl or nba" }, { status: 400 })

  if (body.final === true) {
    const s = (body.stats ?? {}) as FinalStats
    const startedAt = typeof body.startedAt === "string" ? body.startedAt : new Date().toISOString()
    const chunks = num(s.chunks) ?? 0
    const chunksOk = num(s.chunks_ok) ?? 0
    const fetchedFailed = num(s.fetched_failed) ?? 0
    const resolveFailed = num(s.resolve_failed) ?? 0
    const targets = num(s.targets)
    const problems: string[] = []
    if (chunksOk !== chunks) problems.push(`${chunks - chunksOk} of ${chunks} chunks did not land`)
    if (fetchedFailed > 0) problems.push(`${fetchedFailed} ESPN stat fetches failed`)
    if (resolveFailed > 0) problems.push(`${resolveFailed} ESPN searches failed`)
    if (s.deadline_hit === true) problems.push("runner hit its deadline before finishing")
    const ok = problems.length === 0
    await logTerminalRun({
      pipeline: PIPELINE,
      startedAt,
      ok,
      error: ok ? null : problems.join("; "),
      rowsFound: targets,
      rowsWritten: chunks > 0 ? num(s.rows_upserted) : null,
      rowsSkipped: num(s.fetched_404),
      collectionSlug: league === "nfl" ? "nfl_all_day" : "nba_top_shot",
      extra: {
        league,
        source: "espn",
        fetched_ok: num(s.fetched_ok),
        fetched_404: num(s.fetched_404),
        fetched_failed: fetchedFailed,
        chunks,
        chunks_ok: chunksOk,
        resolve_targets: num(s.resolve_targets),
        resolved: num(s.resolved),
        unresolved: num(s.unresolved),
        resolve_failed: resolveFailed,
        deadline_hit: s.deadline_hit === true,
        errors: Array.isArray(s.errors) ? s.errors.slice(0, 10) : null,
        event: typeof s.runner_event === "string" ? s.runner_event : null,
      },
    })
    return NextResponse.json({ ok, problems }, { status: 200 })
  }

  if (Array.isArray(body.espn_ids)) {
    const { data, error } = await supabaseAdmin.rpc("set_player_identity_espn_ids", {
      p_league: league,
      p_rows: body.espn_ids,
    })
    if (error) return NextResponse.json({ error: `espn_ids: ${error.message}` }, { status: 500 })
    return NextResponse.json({ ok: true, updated: typeof data === "number" ? data : 0 }, { status: 200 })
  }

  if (Array.isArray(body.rows)) {
    const touched = Array.isArray(body.touched) ? body.touched.filter((t) => typeof t === "string") : null
    const { data, error } = await supabaseAdmin.rpc("upsert_player_season_stats", {
      p_league: league,
      p_rows: body.rows,
      p_touched: touched,
    })
    if (error) return NextResponse.json({ error: `upsert: ${error.message}` }, { status: 500 })
    return NextResponse.json({ ok: true, upserted: typeof data === "number" ? data : 0 }, { status: 200 })
  }

  return NextResponse.json({ error: "body needs rows, espn_ids or final:true" }, { status: 400 })
}

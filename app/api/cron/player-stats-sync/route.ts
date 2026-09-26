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
//        -> { targets:[{identity_id, espn_id, espn_league, display_name, stats_refreshed_at}] }
//        (espn_league — nba | wnba | nfl — picks the stats path; batch 56)
//        (writes the -heartbeat row: the runner's invocation is then knowable
//        even when the job is killed before its final POST)
//   GET  ?phase=espn-resolve-targets&league=nba&limit=N
//        -> { targets:[{identity_id, display_name, name_slug, aliases[]}] }
//        (aliases: the other spellings RPC knows, for search retries; batch 56)
//   Both GETs take &startedAt=<ISO>&hb=1|0 (2026-09-25): the heartbeat is
//   written by the runner's FIRST call (hb=1) and stamped with the runner's OWN
//   startedAt — the same value the final POST logs. Before this the NBA leg
//   resolved ESPN ids for ~3 min before its targets call, so the heartbeat sat
//   ~160 s after the terminal row's started_at, outside the ±5 s correlation,
//   and the sentinel's Wall Kills arm read every NBA run as a kill (5/10).
//   With no hb param, the targets phase still writes it (older runner).
//   POST { league, espn_ids:[{identity_id, espn_id|null, espn_league|null, matched_by}] }
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

// The runner's own start, when it sent one that is plausible (in the last
// hour, not ahead of this clock by more than a minute); otherwise now. The
// correlation window is ±5 s, so the marker must carry the SAME instant the
// terminal row will — a route-side Date.now() is late by however long the
// runner worked before calling.
function runnerStartMs(raw: string | null): number {
  const now = Date.now()
  if (!raw) return now
  const t = Date.parse(raw)
  if (!Number.isFinite(t) || t > now + 60_000 || t < now - 3_600_000) return now
  return t
}

export async function GET(req: NextRequest) {
  if (!authed(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const phase = req.nextUrl.searchParams.get("phase")
  const league = leagueOf(req.nextUrl.searchParams.get("league"))
  if (!league) return NextResponse.json({ error: "league must be nfl or nba" }, { status: 400 })

  const hb = req.nextUrl.searchParams.get("hb")
  const writeHb = hb === "1" || (hb == null && phase === "targets")
  if (writeHb && (phase === "targets" || phase === "espn-resolve-targets")) {
    await writeInvocationHeartbeat({
      pipeline: PIPELINE,
      startedAtMs: runnerStartMs(req.nextUrl.searchParams.get("startedAt")),
      extra: { league, limit: limitOf(req.nextUrl.searchParams.get("limit"), phase === "targets" ? 300 : 200), first_phase: phase },
    })
  }

  if (phase === "targets") {
    const limit = limitOf(req.nextUrl.searchParams.get("limit"), 300)
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
    // ESPN answers an occasional 500 for one athlete (1 of 300 on the first
    // run); that player stays at the front of the queue and is retried next
    // run, so a failure rate under 5 % is noted, not a failed run. Above it
    // — or ANY chunk that did not land, any search failure, a deadline — is.
    const fetchFailRate = targets && targets > 0 ? fetchedFailed / targets : fetchedFailed > 0 ? 1 : 0
    // The same rule for the name searches (batch 58): a 400-search tick met one
    // ESPN 504 and the whole run read failed. A failed search leaves its target
    // for the next tick, so under 5 % is noted, not failed.
    const resolveTargets = num(s.resolve_targets)
    const resolveFailRate = resolveTargets && resolveTargets > 0 ? resolveFailed / resolveTargets : resolveFailed > 0 ? 1 : 0
    if (fetchedFailed > 0) problems.push(`${fetchedFailed} ESPN stat fetches failed`)
    if (resolveFailed > 0) problems.push(`${resolveFailed} ESPN searches failed`)
    if (s.deadline_hit === true) problems.push("runner hit its deadline before finishing")
    const ok =
      chunksOk === chunks && resolveFailRate < 0.05 && s.deadline_hit !== true && fetchFailRate < 0.05
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
        // named even on an ok run (a sub-threshold ESPN failure is still a fact)
        problems,
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

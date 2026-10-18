import { NextRequest, NextResponse } from "next/server"
import { logTerminalRun } from "@/lib/pipeline/terminal-run"

// TEMPORARY PROBE (2026-10-18, known-issues #8) — can VERCEL's egress reach the free NBA sources?
//
// WHY. `sync-nba-projections` (Supabase edge, sole writer of nba_games + projections) has failed
// every run since 2026-08-04: DraftKings, cdn.nba.com AND site.api.espn.com all answer 403 "Access
// Denied" to Supabase's egress (measured 10-18 11:07 AM PT: dk 403, rolling 403, espn 403). #8 is
// shelved as "no PAID provider before revenue", but nothing has tested whether the FREE sources
// answer from Vercel's egress. If they do, the schedule (nba_games) can come back for free and the
// Fast Break pages can work in-season; if they do not, #8's 10-28 re-look has its answer.
//
// WHAT. Records only HTTP status, latency, byte size and (ESPN) the game count — never a body — in
// one `pipeline_runs` row (`nba-upstream-probe`, ok=true: a probe that ran has succeeded, whatever
// it found). Remove this route and its vercel.json entry once #8 has read it.

export const dynamic = "force-dynamic"
export const maxDuration = 60

const PIPELINE = "nba-upstream-probe"
const TIMEOUT_MS = 10_000
const UA = "Mozilla/5.0 (compatible; rip-packs-city/1.0; +https://rippackscity.com)"

function todayEtCompact(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date())
    .replace(/-/g, "")
}

export type ProbeResult = { status: number | null; ms: number; bytes: number | null; games?: number | null; error?: string }

export async function probe(url: string, countGames = false): Promise<ProbeResult> {
  const t0 = Date.now()
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: ctl.signal, cache: "no-store" })
    const text = await res.text()
    let games: number | null | undefined
    if (countGames) {
      try {
        const j = JSON.parse(text)
        games = Array.isArray(j?.events) ? j.events.length : null
      } catch {
        games = null
      }
    }
    return { status: res.status, ms: Date.now() - t0, bytes: text.length, ...(countGames ? { games } : {}) }
  } catch (e) {
    return { status: null, ms: Date.now() - t0, bytes: null, error: e instanceof Error ? e.name : String(e) }
  } finally {
    clearTimeout(timer)
  }
}

function authorized(request: NextRequest): boolean {
  const auth = request.headers.get("authorization") ?? ""
  const cron = process.env.CRON_SECRET
  const ingest = process.env.INGEST_SECRET_TOKEN
  return (!!cron && auth === `Bearer ${cron}`) || (!!ingest && auth === `Bearer ${ingest}`)
}

export async function GET(request: NextRequest) {
  if (!authorized(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const startedAt = new Date()
  const [espn, nbaSchedule, nbaToday] = await Promise.all([
    probe(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${todayEtCompact()}`, true),
    probe("https://cdn.nba.com/static/json/staticData/scheduleLeagueV2.json"),
    probe("https://cdn.nba.com/static/json/liveData/scoreboard/todaysScoreboard_00.json"),
  ])
  const extra = { region: process.env.VERCEL_REGION ?? null, espn, nba_schedule: nbaSchedule, nba_today: nbaToday }
  await logTerminalRun({ pipeline: PIPELINE, startedAt, ok: true, extra })
  return NextResponse.json({ ok: true, ...extra })
}

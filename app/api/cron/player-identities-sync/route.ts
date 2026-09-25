import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { writeInvocationHeartbeat } from "@/lib/pipeline/heartbeat"
import { logTerminalRun } from "@/lib/pipeline/terminal-run"
import { NFLVERSE_PLAYERS_CSV_URL, chunk, nflverseToIdentityRows } from "@/lib/player-identities/nflverse"

// ─────────────────────────────────────────────────────────────────────────────
// player-identities-sync — refresh the league-id crosswalk (player_identities)
// and link it to RPC's players rows. 2026-09-25, #139 follow-up.
//
// NFL: fetch nflverse players.csv (GSIS id, NFL.com spelling, birth date,
// latest team, seasons, ESPN/PFR ids; ~24.8k rows, 7.2 MB), upsert it through
// upsert_player_identities in chunks, then match_player_identities('nfl')
// links free identities to free players — by name when unique, by the
// editions' TEAM when two league rows share a name, by season next, and
// COUNTS what it cannot break (players_ambiguous) instead of guessing.
//
// NBA: the person id is already players.external_id; seeded by migration
// 20260925225610. No feed yet, so ?league=nba is refused rather than faked.
//
// Honesty: a heartbeat row lands BEFORE the fetch (a maxDuration kill is then
// read by correlation), `ok` is derived from every chunk landing AND the match
// succeeding, rows_written is the sum the RPC returned (never the rows sent),
// and a fetch or parse failure logs ok:false with the error — never 0 rows.
//
// Auth: Bearer INGEST_SECRET_TOKEN (or CRON_SECRET). Caller: the weekly
// .github/workflows/player-identities-sync.yml (curl), or workflow_dispatch.
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic"
export const maxDuration = 300

const PIPELINE = "player-identities-sync"
const UPSERT_CHUNK = 500
const FETCH_TIMEOUT_MS = 90_000

function authed(req: NextRequest): boolean {
  const auth = req.headers.get("authorization")
  if (process.env.INGEST_SECRET_TOKEN && auth === `Bearer ${process.env.INGEST_SECRET_TOKEN}`) return true
  if (process.env.CRON_SECRET && auth === `Bearer ${process.env.CRON_SECRET}`) return true
  return false
}

type Outcome = {
  ok: boolean
  error: string | null
  source_status: number | null
  source_bytes: number | null
  source_rows: number | null
  skipped: number | null
  chunks: number
  chunks_ok: number
  rows_upserted: number
  match: unknown
}

async function syncNfl(fetchImpl: typeof fetch): Promise<Outcome> {
  const out: Outcome = {
    ok: false,
    error: null,
    source_status: null,
    source_bytes: null,
    source_rows: null,
    skipped: null,
    chunks: 0,
    chunks_ok: 0,
    rows_upserted: 0,
    match: null,
  }

  let csv: string
  try {
    const res = await fetchImpl(NFLVERSE_PLAYERS_CSV_URL, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: "follow",
      headers: { "user-agent": "rippackscity-player-identities-sync/1 (+https://www.rippackscity.com)" },
    })
    out.source_status = res.status
    if (!res.ok) {
      out.error = `nflverse fetch: HTTP ${res.status}`
      return out
    }
    csv = await res.text()
    out.source_bytes = csv.length
  } catch (err) {
    out.error = `nflverse fetch: ${err instanceof Error ? err.message : String(err)}`
    return out
  }

  let rows
  try {
    const parsed = nflverseToIdentityRows(csv)
    rows = parsed.rows
    out.source_rows = parsed.source_rows
    out.skipped = parsed.skipped
  } catch (err) {
    out.error = err instanceof Error ? err.message : String(err)
    return out
  }
  if (rows.length === 0) {
    // 24,830 rows on 2026-09-25; zero is a broken source, not an empty league
    out.error = "nflverse players.csv parsed to zero usable rows"
    return out
  }

  const parts = chunk(rows, UPSERT_CHUNK)
  out.chunks = parts.length
  for (const part of parts) {
    const { data, error } = await supabaseAdmin.rpc("upsert_player_identities", {
      p_league: "nfl",
      p_source: "nflverse",
      p_rows: part,
    })
    if (error) {
      out.error = `upsert_player_identities: ${error.message}`
      return out
    }
    out.chunks_ok++
    out.rows_upserted += typeof data === "number" ? data : 0
  }

  const { data: match, error: matchErr } = await supabaseAdmin.rpc("match_player_identities", { p_league: "nfl" })
  if (matchErr) {
    out.error = `match_player_identities: ${matchErr.message}`
    return out
  }
  out.match = match
  out.ok = out.chunks_ok === out.chunks
  return out
}

export async function POST(req: NextRequest) {
  if (!authed(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const league = (req.nextUrl.searchParams.get("league") ?? "nfl").toLowerCase()
  if (league !== "nfl") {
    return NextResponse.json(
      { error: `no feed for league "${league}" — nba identities are seeded from players.external_id (migration 20260925225610)` },
      { status: 400 },
    )
  }

  const startedAt = Date.now()
  await writeInvocationHeartbeat({ pipeline: PIPELINE, startedAtMs: startedAt, extra: { league } })

  const out = await syncNfl(fetch)

  await logTerminalRun({
    pipeline: PIPELINE,
    startedAt,
    ok: out.ok,
    error: out.error,
    rowsFound: out.source_rows,
    rowsWritten: out.chunks > 0 ? out.rows_upserted : null,
    rowsSkipped: out.skipped,
    collectionSlug: "nfl_all_day",
    extra: {
      league,
      source: "nflverse",
      source_status: out.source_status,
      source_bytes: out.source_bytes,
      chunks: out.chunks,
      chunks_ok: out.chunks_ok,
      match: out.match,
      elapsed_ms: Date.now() - startedAt,
    },
  })

  return NextResponse.json({ pipeline: PIPELINE, league, ...out }, { status: out.ok ? 200 : 500 })
}

export async function GET(req: NextRequest) {
  return POST(req)
}

// sync-nba-games — pulls today's NBA schedule + scores from stats.nba.com
// and upserts into nba_games. Idempotent. Cron every 30 min.
//
// Expectations:
//   - stats.nba.com 403s requests without realistic browser headers
//   - on non-200 we log + exit cleanly (do NOT drop existing rows)
//   - tipoff_at parsing is best-effort: scoreboardV2 only carries it as a
//     human-readable string in GAME_STATUS_TEXT before tipoff. We extract
//     it where parseable and use a two-pass upsert so an unparseable poll
//     never nulls out a previously-stored tipoff_at.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0"

const INGEST_SECRET_TOKEN = Deno.env.get("INGEST_SECRET_TOKEN")
if (!INGEST_SECRET_TOKEN) throw new Error("INGEST_SECRET_TOKEN env var required")

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? ""
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

const FUNCTION_VERSION = 1
const PIPELINE = "sync-nba-games"
const COLLECTION_SLUG = "nba_top_shot"

const NBA_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"

const NBA_HEADERS: Record<string, string> = {
  "User-Agent": NBA_USER_AGENT,
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  "Origin": "https://www.nba.com",
  "Referer": "https://www.nba.com/",
  "x-nba-stats-origin": "stats",
  "x-nba-stats-token": "true",
}

// 30 NBA team IDs to 3-letter abbreviations. Includes the historical aliases
// that scoreboardV2 still emits for franchise relocations (NJN, NOH, SEA).
const TEAM_ID_TO_ABBR: Record<string, string> = {
  "1610612737": "ATL",
  "1610612738": "BOS",
  "1610612739": "CLE",
  "1610612740": "NOP", // legacy: NOH, NOK
  "1610612741": "CHI",
  "1610612742": "DAL",
  "1610612743": "DEN",
  "1610612744": "GSW",
  "1610612745": "HOU",
  "1610612746": "LAC",
  "1610612747": "LAL",
  "1610612748": "MIA",
  "1610612749": "MIL",
  "1610612750": "MIN",
  "1610612751": "BKN", // legacy: NJN
  "1610612752": "NYK",
  "1610612753": "ORL",
  "1610612754": "IND",
  "1610612755": "PHI",
  "1610612756": "PHX",
  "1610612757": "POR",
  "1610612758": "SAC",
  "1610612759": "SAS",
  "1610612760": "OKC", // legacy: SEA
  "1610612761": "TOR",
  "1610612762": "UTA",
  "1610612763": "MEM",
  "1610612764": "WAS",
  "1610612765": "DET",
  "1610612766": "CHA",
}

function statusFromGameStatusId(id: number): { status: "scheduled" | "live" | "final"; warned: boolean } {
  if (id === 1) return { status: "scheduled", warned: false }
  if (id === 2) return { status: "live", warned: false }
  if (id === 3) return { status: "final", warned: false }
  return { status: "scheduled", warned: true }
}

// Eastern time helpers — NBA's GAME_DATE_EST is the ET-day the game belongs
// to. We need MM/DD/YYYY for the API and YYYY-MM-DD for our DB.
function todayInET(): { mmddyyyy: string; isoDate: string; offset: string } {
  const now = new Date()
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
  const parts = Object.fromEntries(fmt.formatToParts(now).map(p => [p.type, p.value]))
  const mm = parts.month
  const dd = parts.day
  const yyyy = parts.year
  return {
    mmddyyyy: `${mm}/${dd}/${yyyy}`,
    isoDate: `${yyyy}-${mm}-${dd}`,
    offset: etOffsetForDate(now),
  }
}

function etOffsetForDate(d: Date): string {
  // Returns "-04:00" or "-05:00" for the given instant in America/New_York.
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    timeZoneName: "longOffset",
  })
  const parts = fmt.formatToParts(d)
  const tz = parts.find(p => p.type === "timeZoneName")?.value ?? "GMT-05:00"
  const stripped = tz.replace("GMT", "").replace("UTC", "")
  return stripped || "-05:00"
}

// Parse strings like "7:00 pm ET", "10:30 PM ET", "7:00 pm" into HH:MM.
// Returns null if no clock-time pattern found (e.g. "Final", "Q3 5:23",
// "PPD"). Caller decides whether to skip or fall back.
function parseTipoffClock(statusText: string | null | undefined): { hh: number; mm: number } | null {
  if (!statusText) return null
  const m = statusText.match(/(\d{1,2}):(\d{2})\s*(am|pm|AM|PM)/)
  if (!m) return null
  let hh = parseInt(m[1], 10)
  const mm = parseInt(m[2], 10)
  const ampm = m[3].toLowerCase()
  if (ampm === "pm" && hh !== 12) hh += 12
  if (ampm === "am" && hh === 12) hh = 0
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null
  return { hh, mm }
}

function buildTipoffIso(isoDate: string, statusText: string | null, etOffset: string): string | null {
  const clock = parseTipoffClock(statusText)
  if (!clock) return null
  const hh = String(clock.hh).padStart(2, "0")
  const mm = String(clock.mm).padStart(2, "0")
  return `${isoDate}T${hh}:${mm}:00${etOffset}`
}

interface ResultSet {
  name: string
  headers: string[]
  rowSet: unknown[][]
}

interface ScoreboardResponse {
  resultSets?: ResultSet[]
}

interface ParsedGame {
  gameId: string
  gameDate: string
  homeAbbr: string
  awayAbbr: string
  homeScore: number | null
  awayScore: number | null
  status: "scheduled" | "live" | "final"
  tipoffAtIso: string | null
  unknownStatus: boolean
}

function parseScoreboard(json: ScoreboardResponse, isoDate: string, etOffset: string): {
  games: ParsedGame[]
  unknownStatusCount: number
  missingAbbrCount: number
} {
  const sets = json.resultSets ?? []
  const gameHeader = sets.find(s => s.name === "GameHeader")
  const lineScore = sets.find(s => s.name === "LineScore")
  if (!gameHeader) return { games: [], unknownStatusCount: 0, missingAbbrCount: 0 }

  const headerIdx = (name: string) => gameHeader.headers.indexOf(name)
  const idGame = headerIdx("GAME_ID")
  const idStatusId = headerIdx("GAME_STATUS_ID")
  const idStatusText = headerIdx("GAME_STATUS_TEXT")
  const idHome = headerIdx("HOME_TEAM_ID")
  const idAway = headerIdx("VISITOR_TEAM_ID")

  // LineScore has TEAM_ID + PTS columns. Build score map (gameId, teamId) -> pts.
  const scoreMap = new Map<string, number | null>()
  if (lineScore) {
    const lsGameIdx = lineScore.headers.indexOf("GAME_ID")
    const lsTeamIdx = lineScore.headers.indexOf("TEAM_ID")
    const lsPtsIdx = lineScore.headers.indexOf("PTS")
    if (lsGameIdx >= 0 && lsTeamIdx >= 0 && lsPtsIdx >= 0) {
      for (const row of lineScore.rowSet) {
        const gid = String(row[lsGameIdx])
        const tid = String(row[lsTeamIdx])
        const pts = row[lsPtsIdx]
        const ptsNum = pts == null || pts === "" ? null : Number(pts)
        scoreMap.set(`${gid}:${tid}`, Number.isFinite(ptsNum as number) ? (ptsNum as number) : null)
      }
    }
  }

  let unknownStatusCount = 0
  let missingAbbrCount = 0
  const games: ParsedGame[] = []

  for (const row of gameHeader.rowSet) {
    const gameId = String(row[idGame] ?? "").trim()
    if (!gameId) continue
    const statusIdRaw = Number(row[idStatusId])
    const statusText = String(row[idStatusText] ?? "")
    const homeTeamId = String(row[idHome] ?? "")
    const awayTeamId = String(row[idAway] ?? "")
    const homeAbbr = TEAM_ID_TO_ABBR[homeTeamId]
    const awayAbbr = TEAM_ID_TO_ABBR[awayTeamId]
    if (!homeAbbr || !awayAbbr) {
      missingAbbrCount++
      console.log(`[sync-nba-games] missing team abbr game=${gameId} home=${homeTeamId} away=${awayTeamId}`)
      continue
    }
    const { status, warned } = statusFromGameStatusId(statusIdRaw)
    if (warned) {
      unknownStatusCount++
      console.log(`[sync-nba-games] unknown GAME_STATUS_ID=${statusIdRaw} game=${gameId} text=${statusText}`)
    }
    const homeScore = scoreMap.get(`${gameId}:${homeTeamId}`) ?? null
    const awayScore = scoreMap.get(`${gameId}:${awayTeamId}`) ?? null
    const tipoffAtIso = status === "scheduled" ? buildTipoffIso(isoDate, statusText, etOffset) : null
    games.push({
      gameId,
      gameDate: isoDate,
      homeAbbr,
      awayAbbr,
      homeScore,
      awayScore,
      status,
      tipoffAtIso,
      unknownStatus: warned,
    })
  }

  return { games, unknownStatusCount, missingAbbrCount }
}

async function logRun(args: {
  startedAt: string
  rowsFound: number
  rowsWritten: number
  rowsSkipped: number
  ok: boolean
  error?: string | null
  extra: Record<string, unknown>
}) {
  try {
    // deno-lint-ignore no-explicit-any
    await (supabase as any).rpc("log_pipeline_run", {
      p_pipeline: PIPELINE,
      p_started_at: args.startedAt,
      p_rows_found: args.rowsFound,
      p_rows_written: args.rowsWritten,
      p_rows_skipped: args.rowsSkipped,
      p_ok: args.ok,
      p_error: args.error ?? null,
      p_collection_slug: COLLECTION_SLUG,
      p_cursor_before: null,
      p_cursor_after: null,
      p_extra: args.extra,
    })
  } catch (err) {
    console.log(`[sync-nba-games] log_pipeline_run failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

async function runWork(startedAtIso: string, started: number) {
  const { mmddyyyy, isoDate, offset } = todayInET()
  const url = new URL("https://stats.nba.com/stats/scoreboardV2")
  url.searchParams.set("DayOffset", "0")
  url.searchParams.set("GameDate", mmddyyyy)
  url.searchParams.set("LeagueID", "00")

  let res: Response
  try {
    res = await fetch(url.toString(), {
      method: "GET",
      headers: NBA_HEADERS,
      signal: AbortSignal.timeout(20_000),
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await logRun({
      startedAt: startedAtIso,
      rowsFound: 0, rowsWritten: 0, rowsSkipped: 0,
      ok: false,
      error: `fetch_failed: ${msg}`,
      extra: { function_version: FUNCTION_VERSION, game_date: isoDate, elapsed_ms: Date.now() - started },
    })
    return
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "")
    await logRun({
      startedAt: startedAtIso,
      rowsFound: 0, rowsWritten: 0, rowsSkipped: 0,
      ok: false,
      error: `HTTP ${res.status}`,
      extra: {
        function_version: FUNCTION_VERSION,
        game_date: isoDate,
        body_excerpt: body.slice(0, 500),
        elapsed_ms: Date.now() - started,
      },
    })
    return
  }

  let json: ScoreboardResponse
  try {
    json = await res.json()
  } catch (err) {
    await logRun({
      startedAt: startedAtIso,
      rowsFound: 0, rowsWritten: 0, rowsSkipped: 0,
      ok: false,
      error: `not_json: ${err instanceof Error ? err.message : String(err)}`,
      extra: { function_version: FUNCTION_VERSION, game_date: isoDate, elapsed_ms: Date.now() - started },
    })
    return
  }

  const { games, unknownStatusCount, missingAbbrCount } = parseScoreboard(json, isoDate, offset)

  if (games.length === 0) {
    await logRun({
      startedAt: startedAtIso,
      rowsFound: 0, rowsWritten: 0, rowsSkipped: 0,
      ok: true,
      extra: {
        function_version: FUNCTION_VERSION,
        game_date: isoDate,
        message: "no_games_today",
        unknown_status_count: unknownStatusCount,
        missing_abbr_count: missingAbbrCount,
        elapsed_ms: Date.now() - started,
      },
    })
    return
  }

  const nowIso = new Date(started).toISOString()

  // Pass 1: upsert always-known fields. Omitting tipoff_at means an existing
  // value is never overwritten with NULL.
  const baseRows = games.map(g => ({
    external_game_id: g.gameId,
    game_date: g.gameDate,
    home_team_abbr: g.homeAbbr,
    away_team_abbr: g.awayAbbr,
    home_score: g.homeScore,
    away_score: g.awayScore,
    status: g.status,
    last_synced_at: nowIso,
  }))

  let writeError: string | null = null
  let rowsWritten = 0
  const { error: baseErr } = await supabase
    .from("nba_games")
    .upsert(baseRows, { onConflict: "external_game_id" })
  if (baseErr) {
    writeError = `pass1: ${baseErr.message}`
  } else {
    rowsWritten = baseRows.length
  }

  // Pass 2: for games where we parsed a fresh tipoff time, write it. We must
  // include the NOT NULL columns again because upsert sends a full INSERT row.
  const tipoffRows = games
    .filter(g => g.tipoffAtIso)
    .map(g => ({
      external_game_id: g.gameId,
      game_date: g.gameDate,
      home_team_abbr: g.homeAbbr,
      away_team_abbr: g.awayAbbr,
      status: g.status,
      tipoff_at: g.tipoffAtIso,
      last_synced_at: nowIso,
    }))
  let tipoffWritten = 0
  if (!writeError && tipoffRows.length > 0) {
    const { error: tipErr } = await supabase
      .from("nba_games")
      .upsert(tipoffRows, { onConflict: "external_game_id" })
    if (tipErr) {
      writeError = `pass2_tipoff: ${tipErr.message}`
    } else {
      tipoffWritten = tipoffRows.length
    }
  }

  await logRun({
    startedAt: startedAtIso,
    rowsFound: games.length,
    rowsWritten,
    rowsSkipped: missingAbbrCount,
    ok: !writeError,
    error: writeError,
    extra: {
      function_version: FUNCTION_VERSION,
      game_date: isoDate,
      games_total: games.length,
      games_upserted: rowsWritten,
      tipoff_rows_written: tipoffWritten,
      unknown_status_count: unknownStatusCount,
      missing_abbr_count: missingAbbrCount,
      elapsed_ms: Date.now() - started,
    },
  })
}

Deno.serve(async (req: Request) => {
  const auth = req.headers.get("Authorization") ?? ""
  if (auth !== `Bearer ${INGEST_SECRET_TOKEN}`) {
    return new Response("Unauthorized", { status: 401 })
  }

  const started = Date.now()
  const startedAtIso = new Date(started).toISOString()

  // deno-lint-ignore no-explicit-any
  const edgeRuntime = (globalThis as any).EdgeRuntime
  const workPromise = runWork(startedAtIso, started)
  if (edgeRuntime && typeof edgeRuntime.waitUntil === "function") {
    edgeRuntime.waitUntil(workPromise)
  } else {
    workPromise.catch(e => console.log(`[sync-nba-games] waitUntil fallback err: ${e instanceof Error ? e.message : String(e)}`))
  }

  return new Response(
    JSON.stringify({
      ok: true,
      message: "queued",
      started_at: startedAtIso,
      function_version: FUNCTION_VERSION,
      note: "Real results will appear in pipeline_runs within ~10-30s.",
    }),
    { headers: { "Content-Type": "application/json" } },
  )
})

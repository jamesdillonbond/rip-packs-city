// sync-nba-odds — pulls today's NBA moneyline / spread / total from
// odds-proxy.tdillonbond.workers.dev (which fronts the-odds-api.com),
// computes de-vigged win probability for the home side, and upserts
// onto nba_games rows by team-abbreviation match.
//
// Fire-and-forget: returns 202 immediately and continues in the
// EdgeRuntime.waitUntil background lifetime. Cron-job.org gets a fast
// response even when the upstream is slow or saturated.
//
// Bookmaker preference: FanDuel > DraftKings > BetMGM > first available.
// All three are us-region books at the-odds-api.com so we usually get at
// least one. Falling back to the-first-available keeps tonight's pick
// populated even on edge cases (e.g. fresh playoff games where some
// bookmakers haven't priced yet).
//
// /api/rtr/picks/today reads from nba_games where odds_last_synced_at is
// within the last 90 minutes — fresher than that means a real-time price,
// older means we trust the existing pick rather than churn UX.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0"

const INGEST_SECRET_TOKEN = Deno.env.get("INGEST_SECRET_TOKEN")
if (!INGEST_SECRET_TOKEN) throw new Error("INGEST_SECRET_TOKEN env var required")

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? ""
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

const ODDS_PROXY_URL = Deno.env.get("ODDS_PROXY_URL") ?? "https://odds-proxy.tdillonbond.workers.dev"
const ODDS_PROXY_SECRET = Deno.env.get("ODDS_PROXY_SECRET") ?? ""

const FUNCTION_VERSION = 1
const PIPELINE = "sync-nba-odds"
const COLLECTION_SLUG = "nba_top_shot"

// the-odds-api uses full team names; nba_games uses abbreviations. Static
// map covers all 30 NBA franchises. Verified against scoreboard payloads.
const TEAM_NAME_TO_ABBR: Record<string, string> = {
  "Atlanta Hawks": "ATL",
  "Boston Celtics": "BOS",
  "Brooklyn Nets": "BKN",
  "Charlotte Hornets": "CHA",
  "Chicago Bulls": "CHI",
  "Cleveland Cavaliers": "CLE",
  "Dallas Mavericks": "DAL",
  "Denver Nuggets": "DEN",
  "Detroit Pistons": "DET",
  "Golden State Warriors": "GSW",
  "Houston Rockets": "HOU",
  "Indiana Pacers": "IND",
  "Los Angeles Clippers": "LAC",
  "LA Clippers": "LAC",
  "Los Angeles Lakers": "LAL",
  "Memphis Grizzlies": "MEM",
  "Miami Heat": "MIA",
  "Milwaukee Bucks": "MIL",
  "Minnesota Timberwolves": "MIN",
  "New Orleans Pelicans": "NOP",
  "New York Knicks": "NYK",
  "Oklahoma City Thunder": "OKC",
  "Orlando Magic": "ORL",
  "Philadelphia 76ers": "PHI",
  "Phoenix Suns": "PHX",
  "Portland Trail Blazers": "POR",
  "Sacramento Kings": "SAC",
  "San Antonio Spurs": "SAS",
  "Toronto Raptors": "TOR",
  "Utah Jazz": "UTA",
  "Washington Wizards": "WAS",
}

interface OddsApiOutcome {
  name?: string
  price?: number
  point?: number | null
}
interface OddsApiMarket {
  key?: "h2h" | "spreads" | "totals" | string
  outcomes?: OddsApiOutcome[]
}
interface OddsApiBookmaker {
  key?: string
  title?: string
  last_update?: string
  markets?: OddsApiMarket[]
}
interface OddsApiEvent {
  id?: string
  commence_time?: string
  home_team?: string
  away_team?: string
  bookmakers?: OddsApiBookmaker[]
}

const PREFERRED_BOOKMAKERS = ["fanduel", "draftkings", "betmgm"] as const

function pickBookmaker(books: OddsApiBookmaker[]): OddsApiBookmaker | null {
  if (!books?.length) return null
  for (const key of PREFERRED_BOOKMAKERS) {
    const hit = books.find(b => (b.key ?? "").toLowerCase() === key)
    if (hit) return hit
  }
  return books[0] ?? null
}

function americanToImplied(odds: number | null | undefined): number | null {
  if (odds == null || !Number.isFinite(odds) || odds === 0) return null
  if (odds < 0) {
    const a = Math.abs(odds)
    return a / (a + 100)
  }
  return 100 / (odds + 100)
}

function devigPair(home: number | null, away: number | null): number | null {
  // Returns home-side de-vigged probability ∈ [0,1]. Sums to 1 with the
  // away side, so callers don't need to store the away probability —
  // 1 - home covers it. Returns null if either side is missing.
  const homeRaw = americanToImplied(home)
  const awayRaw = americanToImplied(away)
  if (homeRaw == null || awayRaw == null) return null
  const total = homeRaw + awayRaw
  if (total <= 0) return null
  return Math.round((homeRaw / total) * 10000) / 10000
}

interface ParsedEvent {
  oddsEventId: string | null
  commenceTime: string
  gameDate: string
  homeAbbr: string | null
  awayAbbr: string | null
  bookmakerKey: string
  homeMl: number | null
  awayMl: number | null
  homeSpread: number | null
  totalPoints: number | null
}

function isoDateInET(iso: string | null | undefined): string {
  if (!iso) return ""
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return ""
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
  })
  const parts = Object.fromEntries(fmt.formatToParts(new Date(ms)).map(p => [p.type, p.value]))
  return `${parts.year}-${parts.month}-${parts.day}`
}

function parseEvents(events: OddsApiEvent[]): { parsed: ParsedEvent[]; bookmakerCounts: Record<string, number> } {
  const parsed: ParsedEvent[] = []
  const bookmakerCounts: Record<string, number> = {}

  for (const ev of events) {
    const book = pickBookmaker(ev.bookmakers ?? [])
    if (!book) continue

    const bookKey = (book.key ?? "unknown").toLowerCase()
    bookmakerCounts[bookKey] = (bookmakerCounts[bookKey] ?? 0) + 1

    const homeName = ev.home_team ?? ""
    const awayName = ev.away_team ?? ""
    const homeAbbr = TEAM_NAME_TO_ABBR[homeName] ?? null
    const awayAbbr = TEAM_NAME_TO_ABBR[awayName] ?? null

    const markets = book.markets ?? []
    const h2h = markets.find(m => m.key === "h2h")
    const spreads = markets.find(m => m.key === "spreads")
    const totals = markets.find(m => m.key === "totals")

    let homeMl: number | null = null
    let awayMl: number | null = null
    for (const o of h2h?.outcomes ?? []) {
      if (o.name === homeName) homeMl = typeof o.price === "number" ? o.price : null
      else if (o.name === awayName) awayMl = typeof o.price === "number" ? o.price : null
    }

    let homeSpread: number | null = null
    for (const o of spreads?.outcomes ?? []) {
      if (o.name === homeName) homeSpread = typeof o.point === "number" ? o.point : null
    }

    let totalPoints: number | null = null
    for (const o of totals?.outcomes ?? []) {
      if (typeof o.point === "number") {
        totalPoints = o.point
        break
      }
    }

    parsed.push({
      oddsEventId: ev.id ?? null,
      commenceTime: ev.commence_time ?? "",
      gameDate: isoDateInET(ev.commence_time),
      homeAbbr,
      awayAbbr,
      bookmakerKey: bookKey,
      homeMl,
      awayMl,
      homeSpread,
      totalPoints,
    })
  }

  return { parsed, bookmakerCounts }
}

interface NbaGameRow {
  id: string
  game_date: string
  home_team_abbr: string
  away_team_abbr: string
}

async function loadGamesByDates(dates: string[]): Promise<NbaGameRow[]> {
  if (!dates.length) return []
  const { data, error } = await supabase
    .from("nba_games")
    .select("id, game_date, home_team_abbr, away_team_abbr")
    .in("game_date", dates)
  if (error) {
    console.log(`[sync-nba-odds] nba_games load err: ${error.message}`)
    return []
  }
  return (data ?? []) as NbaGameRow[]
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
    console.log(`[sync-nba-odds] log_pipeline_run failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

async function runWork(startedAtIso: string, started: number) {
  if (!ODDS_PROXY_URL || !ODDS_PROXY_SECRET) {
    await logRun({
      startedAt: startedAtIso,
      rowsFound: 0, rowsWritten: 0, rowsSkipped: 0,
      ok: false,
      error: "missing_proxy_env",
      extra: {
        function_version: FUNCTION_VERSION,
        has_url: !!ODDS_PROXY_URL,
        has_secret: !!ODDS_PROXY_SECRET,
        elapsed_ms: Date.now() - started,
      },
    })
    return
  }

  let res: Response
  try {
    res = await fetch(`${ODDS_PROXY_URL.replace(/\/+$/g, "")}/v4/sports/basketball_nba/odds`, {
      method: "GET",
      headers: { "X-Proxy-Secret": ODDS_PROXY_SECRET },
      signal: AbortSignal.timeout(20_000),
    })
  } catch (err) {
    await logRun({
      startedAt: startedAtIso,
      rowsFound: 0, rowsWritten: 0, rowsSkipped: 0,
      ok: false,
      error: `proxy_fetch_failed: ${err instanceof Error ? err.message : String(err)}`,
      extra: { function_version: FUNCTION_VERSION, elapsed_ms: Date.now() - started },
    })
    return
  }

  const quotaRemaining = res.headers.get("x-quota-remaining")
  const quotaUsed = res.headers.get("x-quota-used")

  if (!res.ok) {
    const body = await res.text().catch(() => "")
    await logRun({
      startedAt: startedAtIso,
      rowsFound: 0, rowsWritten: 0, rowsSkipped: 0,
      ok: false,
      error: `proxy_HTTP_${res.status}`,
      extra: {
        function_version: FUNCTION_VERSION,
        body_excerpt: body.slice(0, 500),
        quota_remaining: quotaRemaining,
        quota_used: quotaUsed,
        elapsed_ms: Date.now() - started,
      },
    })
    return
  }

  let events: OddsApiEvent[]
  try {
    events = await res.json()
    if (!Array.isArray(events)) throw new Error("response not an array")
  } catch (err) {
    await logRun({
      startedAt: startedAtIso,
      rowsFound: 0, rowsWritten: 0, rowsSkipped: 0,
      ok: false,
      error: `not_json: ${err instanceof Error ? err.message : String(err)}`,
      extra: { function_version: FUNCTION_VERSION, elapsed_ms: Date.now() - started },
    })
    return
  }

  const { parsed, bookmakerCounts } = parseEvents(events)
  if (parsed.length === 0) {
    await logRun({
      startedAt: startedAtIso,
      rowsFound: events.length, rowsWritten: 0, rowsSkipped: 0,
      ok: true,
      extra: {
        function_version: FUNCTION_VERSION,
        message: "no_pricable_events",
        events_fetched: events.length,
        quota_remaining: quotaRemaining,
        quota_used: quotaUsed,
        elapsed_ms: Date.now() - started,
      },
    })
    return
  }

  // Match parsed events to nba_games by (game_date, home_abbr, away_abbr).
  // Pull all games for the dates we saw in the odds payload — usually 1-2
  // calendar dates because cron runs while a slate is on or pending.
  const dates = Array.from(new Set(parsed.map(p => p.gameDate).filter(Boolean)))
  const games = await loadGamesByDates(dates)
  const gameKey = (date: string, home: string, away: string) =>
    `${date}|${home.toUpperCase()}|${away.toUpperCase()}`
  const gameByKey = new Map<string, NbaGameRow>()
  for (const g of games) {
    gameByKey.set(gameKey(g.game_date, g.home_team_abbr, g.away_team_abbr), g)
  }

  const nowIso = new Date(started).toISOString()
  let matched = 0
  let updated = 0
  let abbrMisses = 0
  let nbaGamesMisses = 0
  const updateErrors: string[] = []

  // Sequential update loop — only ~10-15 games on a heavy night; the round
  // trip cost is dominated by the upstream fetch above.
  for (const p of parsed) {
    if (!p.homeAbbr || !p.awayAbbr) {
      abbrMisses++
      continue
    }
    const game = gameByKey.get(gameKey(p.gameDate, p.homeAbbr, p.awayAbbr))
    if (!game) {
      nbaGamesMisses++
      continue
    }
    matched++

    const devig = devigPair(p.homeMl, p.awayMl)
    const { error } = await supabase
      .from("nba_games")
      .update({
        home_moneyline: p.homeMl,
        away_moneyline: p.awayMl,
        home_spread: p.homeSpread,
        total_points: p.totalPoints,
        home_win_probability_devig: devig,
        odds_bookmaker: p.bookmakerKey,
        odds_last_synced_at: nowIso,
      })
      .eq("id", game.id)
    if (error) {
      updateErrors.push(`${game.id}: ${error.message}`)
    } else {
      updated++
    }
  }

  await logRun({
    startedAt: startedAtIso,
    rowsFound: events.length,
    rowsWritten: updated,
    rowsSkipped: abbrMisses + nbaGamesMisses,
    ok: updateErrors.length === 0,
    error: updateErrors.length > 0 ? `update_errors: ${updateErrors[0]}` : null,
    extra: {
      function_version: FUNCTION_VERSION,
      events_fetched: events.length,
      events_parsed: parsed.length,
      games_matched: matched,
      games_updated: updated,
      abbr_misses: abbrMisses,
      nba_games_misses: nbaGamesMisses,
      bookmaker_counts: bookmakerCounts,
      quota_remaining: quotaRemaining,
      quota_used: quotaUsed,
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
    workPromise.catch(e => console.log(`[sync-nba-odds] waitUntil fallback err: ${e instanceof Error ? e.message : String(e)}`))
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

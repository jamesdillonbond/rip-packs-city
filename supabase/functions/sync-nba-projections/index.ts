// sync-nba-projections — pulls today's NBA projections AND today's games
// from rpc-sports-proxy + ESPN.
//
// 2026-05-07 PIVOT pt 2: Akamai's TLS / IP fingerprinting on stats.nba.com
// AND draftkings.com is now blocking the worker entirely — pipeline_runs
// rows show via=none + both_upstreams_failed across multiple cycles. UA
// rotation + sec-fetch hardening can't bypass a TLS-fingerprint block.
//
// New 3-tier fallback chain (in order):
//
//   1. /nba/rolling-projections via rpc-sports-proxy (cdn.nba.com games +
//      stats.nba.com rolling-5 players). Best signal when it works.
//   2. /nba/draftkings-projections via rpc-sports-proxy. DK's model
//      projections, MEDIUM confidence. Both worker routes share an Akamai
//      surface — frequently both fail at the same time today.
//   3. site.api.espn.com scoreboard (direct, no proxy). ESPN doesn't use
//      Akamai and doesn't TLS-fingerprint. Returns today's games + each
//      team's stat-category "rating" leader with PPG/RPG/APG/SPG/BPG
//      embedded in the displayValue. Coverage is thin (~1-2 named players
//      per team) but it's the only source emitting fresh data on Akamai-
//      blocked days. Confidence labelled LOW.
//
// Two writes per run:
//   1. nba_games (upsert by external_game_id). cdn.nba.com gives 10-digit
//      IDs; ESPN gives event IDs ("401809241" etc); DK gives 7-digit. We
//      prefer cdn.nba.com when present so the table stays homogeneous,
//      but accept whichever upstream produced games when others failed.
//   2. nba_player_projections (upsert by nba_player_id+game_id+source).
// Resolves players against nba_players.full_name_normalized first, then
// nba_player_aliases, then auto-INSERTs a new nba_players row if neither hits.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0"

const INGEST_SECRET_TOKEN = Deno.env.get("INGEST_SECRET_TOKEN")
if (!INGEST_SECRET_TOKEN) throw new Error("INGEST_SECRET_TOKEN env var required")

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? ""
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

const SPORTS_PROXY_URL = Deno.env.get("SPORTS_PROXY_URL") ?? ""
const SPORTS_PROXY_SECRET = Deno.env.get("SPORTS_PROXY_SECRET") ?? ""

const FUNCTION_VERSION = 6
const PIPELINE = "sync-nba-projections"
const COLLECTION_SLUG = "nba_top_shot"

const ROLLING_ROUTE = "/nba/rolling-projections"
const DK_ROUTE = "/nba/draftkings-projections"

const ROLLING_SOURCE = "nba-stats-rolling5"
const ROLLING_METHOD = "rolling-5-game-fantasy-average"
const DK_SOURCE = "draftkings"
const DK_METHOD = "draftkings-model"
const ESPN_SOURCE = "espn-team-leader"
const ESPN_METHOD = "espn-season-rating-leader"
const ESPN_SCOREBOARD_URL = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard"

interface ProxyPlayer {
  name: string
  teamAbbr: string | null
  position: string | null
  salary: number | null
  status: string | null
  projFp: number | null
  proj_points?: number | null
  proj_rebounds?: number | null
  proj_assists?: number | null
  proj_threes?: number | null
  proj_steals?: number | null
  proj_blocks?: number | null
  proj_turnovers?: number | null
  proj_minutes?: number | null
  opponentAbbr: string | null
  gameStartTime: string | null
  gp?: number | null
}

interface ProxyGame {
  gameId: string
  name: string
  homeAbbr: string | null
  awayAbbr: string | null
  startTime: string | null
  gameDate: string | null
}

interface ProxyResponse {
  draftGroupId: number | null
  gameDate: string
  players: ProxyPlayer[]
  games?: ProxyGame[]
  source?: string
  season?: string
  seasonType?: string
  note?: string
}

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

function normalizeJs(s: string): string {
  // Mirrors public.normalize_player_name(): unaccent + strip non-alphabetic
  // + lowercase. NFD splits accented chars into base + combining mark, then
  // we strip the combining-mark range U+0300 through U+036F.
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-zA-Z]/g, "")
    .toLowerCase()
}

function mapInjuryStatus(raw: string | null): string {
  if (!raw) return "ACTIVE"
  const u = raw.trim().toUpperCase()
  if (u === "" || u === "NONE" || u === "GO" || u === "ACTIVE" || u === "AVAILABLE" || u === "PROBABLE") return "ACTIVE"
  if (u === "GTD" || u === "Q" || u === "QUESTIONABLE" || u === "DTD") return "QUESTIONABLE"
  if (u === "OUT" || u === "INJ" || u === "INJURED" || u === "OFS") return "OUT"
  return "ACTIVE"
}

interface MatchedPlayer {
  scraped: ProxyPlayer
  nbaPlayerId: string
  autoInserted: boolean
}

interface MatchResult {
  matched: MatchedPlayer[]
  noNameSkipped: number
}

async function resolveOrInsertPlayers(scraped: ProxyPlayer[]): Promise<MatchResult> {
  const matched: MatchedPlayer[] = []
  let noNameSkipped = 0

  for (const sp of scraped) {
    if (!sp.name) {
      noNameSkipped++
      continue
    }
    const normalized = normalizeJs(sp.name)

    // Step 1: direct match on full_name_normalized.
    const { data: direct, error: directErr } = await supabase
      .from("nba_players")
      .select("id")
      .eq("full_name_normalized", normalized)
      .limit(1)
    if (directErr) {
      console.log(`[sync-nba-projections] direct lookup err name="${sp.name}": ${directErr.message}`)
      continue
    }
    if (direct && direct.length > 0) {
      matched.push({ scraped: sp, nbaPlayerId: direct[0].id, autoInserted: false })
      continue
    }

    // Step 2: alias lookup.
    const { data: alias, error: aliasErr } = await supabase
      .from("nba_player_aliases")
      .select("nba_player_id")
      .eq("alias_normalized", normalized)
      .limit(1)
    if (aliasErr) {
      console.log(`[sync-nba-projections] alias lookup err name="${sp.name}": ${aliasErr.message}`)
      continue
    }
    if (alias && alias.length > 0) {
      matched.push({ scraped: sp, nbaPlayerId: alias[0].nba_player_id, autoInserted: false })
      continue
    }

    // Step 3: insert a new nba_players row. We rely on full_name_normalized
    // UNIQUE so concurrent inserts collapse safely.
    const insertRow = {
      full_name: sp.name,
      full_name_normalized: normalized,
      current_team_abbr: sp.teamAbbr,
      position: sp.position,
      is_active_2026: true,
    }
    const { data: inserted, error: insErr } = await supabase
      .from("nba_players")
      .upsert(insertRow, { onConflict: "full_name_normalized" })
      .select("id")
      .single()
    if (insErr || !inserted) {
      console.log(`[sync-nba-projections] insert err name="${sp.name}": ${insErr?.message ?? "unknown"}`)
      continue
    }
    matched.push({ scraped: sp, nbaPlayerId: inserted.id, autoInserted: true })
  }

  return { matched, noNameSkipped }
}

function deriveGameStatus(startTime: string | null, nowMs: number): "scheduled" | "live" | "final" {
  if (!startTime) return "scheduled"
  const ms = Date.parse(startTime)
  if (!Number.isFinite(ms)) return "scheduled"
  const fourHr = 4 * 60 * 60 * 1000
  const diff = nowMs - ms
  if (diff > fourHr) return "final"
  if (diff >= -fourHr) return "live"
  return "scheduled"
}

interface UpsertGamesResult {
  total: number
  upserted: number
  skipped: number
  error: string | null
}

async function upsertGames(games: ProxyGame[], fallbackGameDate: string, nowMs: number): Promise<UpsertGamesResult> {
  const total = games.length
  if (total === 0) return { total: 0, upserted: 0, skipped: 0, error: null }

  let skipped = 0
  const rows: Record<string, unknown>[] = []
  const nowIso = new Date(nowMs).toISOString()
  for (const g of games) {
    if (!g.gameId || !g.homeAbbr || !g.awayAbbr) {
      skipped++
      continue
    }
    rows.push({
      external_game_id: g.gameId,
      game_date: g.gameDate ?? fallbackGameDate,
      home_team_abbr: g.homeAbbr,
      away_team_abbr: g.awayAbbr,
      tipoff_at: g.startTime,
      status: deriveGameStatus(g.startTime, nowMs),
      last_synced_at: nowIso,
    })
  }

  if (rows.length === 0) return { total, upserted: 0, skipped, error: null }

  const { error } = await supabase
    .from("nba_games")
    .upsert(rows, { onConflict: "external_game_id" })
  if (error) return { total, upserted: 0, skipped, error: error.message }
  return { total, upserted: rows.length, skipped, error: null }
}

interface GameMatch {
  gameId: string
  homeAbbr: string
  awayAbbr: string
}

async function loadTodaysGames(gameDate: string): Promise<GameMatch[]> {
  const { data, error } = await supabase
    .from("nba_games")
    .select("id, home_team_abbr, away_team_abbr")
    .eq("game_date", gameDate)
  if (error) {
    console.log(`[sync-nba-projections] nba_games load err: ${error.message}`)
    return []
  }
  return (data ?? []).map(r => ({
    gameId: r.id as string,
    homeAbbr: String(r.home_team_abbr),
    awayAbbr: String(r.away_team_abbr),
  }))
}

function findGameForTeam(games: GameMatch[], teamAbbr: string | null): { gameId: string; opponentAbbr: string } | null {
  if (!teamAbbr) return null
  const ta = teamAbbr.trim().toUpperCase()
  for (const g of games) {
    if (g.homeAbbr.toUpperCase() === ta) return { gameId: g.gameId, opponentAbbr: g.awayAbbr }
    if (g.awayAbbr.toUpperCase() === ta) return { gameId: g.gameId, opponentAbbr: g.homeAbbr }
  }
  return null
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
    console.log(`[sync-nba-projections] log_pipeline_run failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

interface ProxyAttempt {
  ok: boolean
  status: number | null
  body: ProxyResponse | null
  error: string | null
  upstream_status: number | null
  upstream_body_excerpt: string | null
}

async function callProxyRoute(route: string): Promise<ProxyAttempt> {
  let res: Response
  try {
    res = await fetch(`${SPORTS_PROXY_URL.replace(/\/+$/g, "")}${route}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Proxy-Secret": SPORTS_PROXY_SECRET,
      },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(45_000),
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, status: null, body: null, error: `fetch_failed: ${msg}`, upstream_status: null, upstream_body_excerpt: null }
  }

  let parsed: ProxyResponse | { error?: string; status?: number; body_excerpt?: string }
  try {
    parsed = await res.json()
  } catch (err) {
    return { ok: false, status: res.status, body: null, error: `not_json: ${err instanceof Error ? err.message : String(err)}`, upstream_status: null, upstream_body_excerpt: null }
  }

  if (!res.ok) {
    const errBody = parsed as { error?: string; status?: number; body_excerpt?: string }
    return {
      ok: false,
      status: res.status,
      body: null,
      error: `HTTP_${res.status}: ${errBody.error ?? "unknown"}`,
      upstream_status: errBody.status ?? null,
      upstream_body_excerpt: errBody.body_excerpt ?? null,
    }
  }

  return { ok: true, status: res.status, body: parsed as ProxyResponse, error: null, upstream_status: null, upstream_body_excerpt: null }
}

// ─── ESPN tier-3 fallback ────────────────────────────────────────────────
// site.api.espn.com is open to Supabase egress (no Akamai, no TLS-fingerprint
// gate). Scoreboard returns today's games + each team's leaders array; the
// "rating" category embeds PPG/RPG/APG/SPG/BPG in a single displayValue
// string per team's MVP. Parsing that string gives us a single rich row
// per team without per-player calls.

interface EspnLeader {
  athlete?: { id?: string | number; fullName?: string; displayName?: string }
  displayValue?: string
  value?: number
}
interface EspnLeaderCategory { name?: string; displayName?: string; leaders?: EspnLeader[] }
interface EspnCompetitor {
  homeAway?: "home" | "away"
  team?: { id?: string | number; abbreviation?: string; displayName?: string }
  leaders?: EspnLeaderCategory[]
}
interface EspnEvent {
  id?: string
  date?: string
  competitions?: Array<{ competitors?: EspnCompetitor[] }>
}
interface EspnScoreboard { events?: EspnEvent[] }

// Match a "23.9 PPG, 5.5 RPG, 9.9 APG, 1.4 SPG, 0.8 BPG" rating display.
// Each stat is optional in case ESPN drops one; we treat missing as 0.
function parseRatingString(s: string): {
  pts: number; reb: number; ast: number; stl: number; blk: number
} | null {
  if (!s) return null
  const grab = (re: RegExp): number => {
    const m = s.match(re)
    if (!m) return 0
    const n = parseFloat(m[1])
    return Number.isFinite(n) ? n : 0
  }
  const pts = grab(/([\d.]+)\s*PPG/i)
  const reb = grab(/([\d.]+)\s*RPG/i)
  const ast = grab(/([\d.]+)\s*APG/i)
  const stl = grab(/([\d.]+)\s*SPG/i)
  const blk = grab(/([\d.]+)\s*BPG/i)
  if (pts === 0 && reb === 0 && ast === 0) return null
  return { pts, reb, ast, stl, blk }
}

function dkFantasyFromBaseStats(s: { pts: number; reb: number; ast: number; stl: number; blk: number }): number {
  // No threes / TOV / DD2 / TD3 in the rating string — approximate.
  const fp = s.pts + 1.2 * s.reb + 1.5 * s.ast + 3 * s.stl + 3 * s.blk
  return Math.round(fp * 100) / 100
}

interface EspnFetchOutcome {
  ok: boolean
  status: number | null
  body: ProxyResponse | null
  error: string | null
}

async function callEspnScoreboard(): Promise<EspnFetchOutcome> {
  let res: Response
  try {
    res = await fetch(ESPN_SCOREBOARD_URL, {
      method: "GET",
      headers: {
        "Accept": "application/json",
        "User-Agent": "Mozilla/5.0 (compatible; rip-packs-city/1.0; +https://rippackscity.com)",
      },
      signal: AbortSignal.timeout(15_000),
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, status: null, body: null, error: `espn_fetch_failed: ${msg}` }
  }
  if (!res.ok) {
    return { ok: false, status: res.status, body: null, error: `espn_HTTP_${res.status}` }
  }
  let json: EspnScoreboard
  try { json = await res.json() } catch (err) {
    return { ok: false, status: res.status, body: null, error: `espn_not_json: ${err instanceof Error ? err.message : String(err)}` }
  }

  const games: ProxyGame[] = []
  const players: ProxyPlayer[] = []
  const seenPlayerKey = new Set<string>()
  const todayET = todayInET()

  for (const ev of json.events ?? []) {
    const comp = ev.competitions?.[0]
    if (!comp) continue
    const home = comp.competitors?.find(c => c.homeAway === "home")
    const away = comp.competitors?.find(c => c.homeAway === "away")
    const homeAbbr = home?.team?.abbreviation?.toUpperCase() ?? null
    const awayAbbr = away?.team?.abbreviation?.toUpperCase() ?? null
    if (!ev.id || !homeAbbr || !awayAbbr) continue

    games.push({
      gameId: String(ev.id),
      name: `${awayAbbr} @ ${homeAbbr}`,
      homeAbbr,
      awayAbbr,
      startTime: ev.date ?? null,
      gameDate: todayET,
    })

    for (const competitor of [home, away]) {
      if (!competitor) continue
      const teamAbbr = competitor.team?.abbreviation?.toUpperCase() ?? null
      const opponentAbbr = competitor === home ? awayAbbr : homeAbbr
      // Iterate every leader category; dedupe by athlete.id so the same
      // player doesn't get 4 rows when they lead PTS + AST + rating.
      for (const cat of competitor.leaders ?? []) {
        for (const ld of cat.leaders ?? []) {
          const athleteId = ld.athlete?.id ? String(ld.athlete.id) : ""
          const name = (ld.athlete?.fullName ?? ld.athlete?.displayName ?? "").trim()
          if (!name) continue
          const key = athleteId ? `id:${athleteId}` : `name:${name.toLowerCase()}|team:${teamAbbr ?? ""}`
          if (seenPlayerKey.has(key)) continue

          // Prefer the rating-category display because it carries all 5
          // stats. Other categories carry just one (PTS/REB/AST). For
          // single-stat leaders we still emit a row but with reduced
          // fantasy approximation.
          const display = String(ld.displayValue ?? "")
          let stats = parseRatingString(display)
          if (!stats) {
            // Single-stat fallback — assign to whichever stat the cat is.
            const v = typeof ld.value === "number" ? ld.value : parseFloat(display)
            if (!Number.isFinite(v)) continue
            const catName = (cat.name ?? "").toLowerCase()
            stats = {
              pts: catName.includes("point") ? v : 0,
              reb: catName.includes("rebound") ? v : 0,
              ast: catName.includes("assist") ? v : 0,
              stl: 0, blk: 0,
            }
            if (stats.pts === 0 && stats.reb === 0 && stats.ast === 0) continue
          }

          seenPlayerKey.add(key)
          const fp = dkFantasyFromBaseStats(stats)
          players.push({
            name,
            teamAbbr: teamAbbr,
            position: null,
            salary: null,
            status: null,
            projFp: fp,
            proj_points: stats.pts,
            proj_rebounds: stats.reb,
            proj_assists: stats.ast,
            proj_threes: null,
            proj_steals: stats.stl,
            proj_blocks: stats.blk,
            proj_turnovers: null,
            proj_minutes: null,
            opponentAbbr,
            gameStartTime: ev.date ?? null,
          })
        }
      }
    }
  }

  return {
    ok: true,
    status: res.status,
    body: {
      draftGroupId: null,
      gameDate: todayET,
      players,
      games,
      source: ESPN_SOURCE,
      note: games.length === 0 ? "no_nba_slate_today" : undefined,
    },
    error: null,
  }
}

async function runWork(startedAtIso: string, started: number) {
  const gameDate = todayInET()

  if (!SPORTS_PROXY_URL || !SPORTS_PROXY_SECRET) {
    await logRun({
      startedAt: startedAtIso,
      rowsFound: 0, rowsWritten: 0, rowsSkipped: 0,
      ok: false,
      error: "missing_proxy_env",
      extra: {
        function_version: FUNCTION_VERSION,
        game_date: gameDate,
        has_url: !!SPORTS_PROXY_URL,
        has_secret: !!SPORTS_PROXY_SECRET,
        elapsed_ms: Date.now() - started,
      },
    })
    return
  }

  // Step 1 — primary attempt: rolling-projections.
  const rolling = await callProxyRoute(ROLLING_ROUTE)
  const rollingPlayers = rolling.body?.players ?? []
  const rollingGames = rolling.body?.games ?? []
  const rollingDegraded = !rolling.ok || rollingPlayers.length === 0

  // Step 2 — fallback to DK when rolling failed entirely OR when rolling
  // returned no players. DK's payload format is the same shape; only the
  // source label and confidence tier change.
  let dk: ProxyAttempt | null = null
  if (rollingDegraded) {
    dk = await callProxyRoute(DK_ROUTE)
  }

  const dkPlayers = dk?.body?.players ?? []
  const dkGames = dk?.body?.games ?? []
  const dkDegraded = !dk || !dk.ok || dkPlayers.length === 0

  // Step 3 — ESPN scoreboard fallback. Hits site.api.espn.com directly
  // (no proxy worker, no Akamai surface). Only fires when both worker
  // routes failed to produce players. Coverage is thin but ESPN doesn't
  // share the TLS-fingerprint block that's currently breaking the worker
  // upstreams, so it's the path that actually works on bad-Akamai days.
  let espn: EspnFetchOutcome | null = null
  if (rollingDegraded && dkDegraded) {
    espn = await callEspnScoreboard()
  }
  const espnPlayers = espn?.body?.players ?? []
  const espnGames = espn?.body?.games ?? []

  // Decide what to write. Source picks the players upstream; gamesSource
  // picks which payload's `games` array we upsert from. We always prefer
  // the most-authoritative games payload available (cdn.nba.com 10-digit
  // IDs > DK 7-digit IDs > ESPN event IDs).
  let scraped: ProxyPlayer[] = []
  let proxyGames: ProxyGame[] = []
  let activeSource = ROLLING_SOURCE
  let activeMethod = ROLLING_METHOD
  // nba_player_projections.confidence CHECK constraint allows HIGH/MED/LOW
  // (3-letter MED, not MEDIUM). Mismatch crashes the upsert with
  // "violates check constraint nba_player_projections_confidence_check".
  let activeConfidence: "HIGH" | "MED" | "LOW" = "LOW"
  let viaTag = "rolling"

  // Choose the games payload first (most authoritative wins).
  let chosenGames: ProxyGame[] = []
  let gamesSource = "none"
  if (rollingGames.length > 0) { chosenGames = rollingGames; gamesSource = "rolling" }
  else if (dkGames.length > 0) { chosenGames = dkGames; gamesSource = "dk" }
  else if (espnGames.length > 0) { chosenGames = espnGames; gamesSource = "espn" }

  if (rolling.ok && rollingPlayers.length > 0) {
    scraped = rollingPlayers
    proxyGames = chosenGames
    activeSource = ROLLING_SOURCE
    activeMethod = ROLLING_METHOD
    activeConfidence = "LOW"
    viaTag = `rolling+${gamesSource}-games`
  } else if (dk && dk.ok && dkPlayers.length > 0) {
    scraped = dkPlayers
    proxyGames = chosenGames
    activeSource = DK_SOURCE
    activeMethod = DK_METHOD
    activeConfidence = "MED"
    viaTag = `dk+${gamesSource}-games`
  } else if (espn && espn.ok && espnPlayers.length > 0) {
    scraped = espnPlayers
    proxyGames = chosenGames
    activeSource = ESPN_SOURCE
    activeMethod = ESPN_METHOD
    activeConfidence = "LOW"
    viaTag = `espn+${gamesSource}-games`
  } else if (chosenGames.length > 0) {
    // Some upstream produced games but nobody produced players.
    proxyGames = chosenGames
    viaTag = `${gamesSource}-games-only`
  }
  // If everything failed entirely, scraped + proxyGames stay empty.

  // Hard-fail only when ALL THREE upstreams failed AND we have nothing
  // to write — not even games.
  if (chosenGames.length === 0 && scraped.length === 0) {
    await logRun({
      startedAt: startedAtIso,
      rowsFound: 0, rowsWritten: 0, rowsSkipped: 0,
      ok: false,
      error: `all_upstreams_failed`,
      extra: {
        function_version: FUNCTION_VERSION,
        game_date: gameDate,
        via: "none",
        rolling_error: rolling.error,
        rolling_status: rolling.status,
        rolling_upstream_status: rolling.upstream_status,
        rolling_body_excerpt: rolling.upstream_body_excerpt,
        dk_attempted: !!dk,
        dk_error: dk?.error ?? null,
        dk_status: dk?.status ?? null,
        dk_upstream_status: dk?.upstream_status ?? null,
        dk_body_excerpt: dk?.upstream_body_excerpt ?? null,
        espn_attempted: !!espn,
        espn_error: espn?.error ?? null,
        espn_status: espn?.status ?? null,
        elapsed_ms: Date.now() - started,
      },
    })
    return
  }

  const proxy: ProxyResponse = (rolling.body ?? dk?.body ?? espn?.body) as ProxyResponse

  // Upsert games BEFORE player resolution so loadTodaysGames() picks up newly
  // inserted rows on the same run. This is the single writer for nba_games
  // now that sync-nba-games is retired (returns 410).
  const gamesResult = await upsertGames(proxyGames, gameDate, started)

  if (scraped.length === 0) {
    // Three flavours of "no players": (a) no slate today, (b) rolling worked
    // for games but stats.nba.com player-stats blocked AND DK fallback also
    // empty/failed, (c) both upstreams failed — handled separately above.
    // Either way nba_games may have been refreshed from cdn.nba.com — only
    // the projection tier degrades. ok=true keeps the cron green; the via
    // tag + error fields tell the operator which upstream produced what.
    await logRun({
      startedAt: startedAtIso,
      rowsFound: 0, rowsWritten: 0, rowsSkipped: 0,
      ok: true,
      extra: {
        function_version: FUNCTION_VERSION,
        game_date: gameDate,
        source: activeSource,
        via: viaTag,
        message: proxy?.note ?? "no_players_returned",
        season: proxy?.season ?? null,
        season_type: proxy?.seasonType ?? null,
        rolling_ok: rolling.ok,
        rolling_players: rollingPlayers.length,
        rolling_note: rolling.body?.note ?? null,
        rolling_error: rolling.error,
        dk_attempted: !!dk,
        dk_ok: dk?.ok ?? null,
        dk_players: dkPlayers.length,
        dk_error: dk?.error ?? null,
        espn_attempted: !!espn,
        espn_ok: espn?.ok ?? null,
        espn_players: espnPlayers.length,
        espn_error: espn?.error ?? null,
        games_total: gamesResult.total,
        games_upserted: gamesResult.upserted,
        games_skipped: gamesResult.skipped,
        games_error: gamesResult.error,
        elapsed_ms: Date.now() - started,
      },
    })
    return
  }

  const games = await loadTodaysGames(gameDate)
  const { matched, noNameSkipped } = await resolveOrInsertPlayers(scraped)

  const projectionRows: Record<string, unknown>[] = []
  let noGameMatch = 0
  const noGameSamples: string[] = []
  let autoInsertedCount = 0
  const nowIso = new Date(started).toISOString()

  for (const m of matched) {
    if (m.autoInserted) autoInsertedCount++
    const game = findGameForTeam(games, m.scraped.teamAbbr)
    if (!game) {
      noGameMatch++
      if (noGameSamples.length < 10) {
        noGameSamples.push(`${m.scraped.name} (${m.scraped.teamAbbr ?? "?"})`)
      }
      continue
    }
    projectionRows.push({
      nba_player_id: m.nbaPlayerId,
      game_id: game.gameId,
      game_date: gameDate,
      proj_fp_dk: m.scraped.projFp,
      proj_points: m.scraped.proj_points ?? null,
      proj_rebounds: m.scraped.proj_rebounds ?? null,
      proj_assists: m.scraped.proj_assists ?? null,
      proj_threes: m.scraped.proj_threes ?? null,
      proj_steals: m.scraped.proj_steals ?? null,
      proj_blocks: m.scraped.proj_blocks ?? null,
      proj_turnovers: m.scraped.proj_turnovers ?? null,
      proj_minutes: m.scraped.proj_minutes ?? null,
      injury_status: mapInjuryStatus(m.scraped.status),
      // Confidence tracks the active upstream: DK's model is MED,
      // stats.nba.com rolling-5 is LOW, ESPN team-leader is LOW.
      // Constraint allows HIGH/MED/LOW (3-letter MED, not MEDIUM).
      confidence: activeConfidence,
      source: activeSource,
      projection_method: activeMethod,
      last_synced_at: nowIso,
    })
  }

  let writeError: string | null = gamesResult.error ? `games_upsert: ${gamesResult.error}` : null
  let upserted = 0
  if (projectionRows.length > 0) {
    const { error } = await supabase
      .from("nba_player_projections")
      .upsert(projectionRows, { onConflict: "nba_player_id,game_id,source" })
    if (error) writeError = writeError ?? `upsert: ${error.message}`
    else upserted = projectionRows.length
  }

  await logRun({
    startedAt: startedAtIso,
    rowsFound: scraped.length,
    rowsWritten: upserted,
    rowsSkipped: noNameSkipped + noGameMatch,
    ok: !writeError,
    error: writeError,
    extra: {
      function_version: FUNCTION_VERSION,
      game_date: gameDate,
      source: activeSource,
      via: viaTag,
      season: proxy?.season ?? null,
      season_type: proxy?.seasonType ?? null,
      rows_parsed: scraped.length,
      players_matched: matched.length,
      players_auto_inserted: autoInsertedCount,
      projections_upserted: upserted,
      no_game_match_count: noGameMatch,
      no_game_match_samples: noGameSamples,
      no_name_skipped: noNameSkipped,
      games_today: games.length,
      games_total: gamesResult.total,
      games_upserted: gamesResult.upserted,
      games_skipped: gamesResult.skipped,
      games_error: gamesResult.error,
      rolling_ok: rolling.ok,
      rolling_players: rollingPlayers.length,
      rolling_note: rolling.body?.note ?? null,
      dk_attempted: !!dk,
      dk_ok: dk?.ok ?? null,
      dk_players: dkPlayers.length,
      dk_error: dk?.error ?? null,
      espn_attempted: !!espn,
      espn_ok: espn?.ok ?? null,
      espn_players: espnPlayers.length,
      espn_error: espn?.error ?? null,
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
    workPromise.catch(e => console.log(`[sync-nba-projections] waitUntil fallback err: ${e instanceof Error ? e.message : String(e)}`))
  }

  return new Response(
    JSON.stringify({
      ok: true,
      message: "queued",
      started_at: startedAtIso,
      function_version: FUNCTION_VERSION,
      primary_source: ROLLING_SOURCE,
      fallback_sources: [DK_SOURCE, ESPN_SOURCE],
      note: "Real results will appear in pipeline_runs within ~30-60s.",
    }),
    { headers: { "Content-Type": "application/json" } },
  )
})

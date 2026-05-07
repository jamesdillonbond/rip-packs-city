// sync-nba-projections — pulls today's NBA projections AND today's games
// from rpc-sports-proxy.
//
// 2026-05-07 PIVOT: stats.nba.com began 520'ing scoreboard requests in
// addition to the existing player-stats block, leaving the function
// running ok=true but writing 0 projections every cycle and intermittent
// 502s on the games side. This rev adds a DraftKings fallback chain:
//
//   1. Call /nba/rolling-projections (cdn.nba.com games + stats.nba.com
//      rolling-5 players). On a clean run this still wins — it's the only
//      source today that emits the canonical 10-digit cdn.nba.com game IDs.
//   2. If rolling returns 502 OR returns 200 with players=[] AND a
//      degradation note, call /nba/draftkings-projections in a second
//      round-trip. DK's Akamai surface was hardened in the May 7 worker
//      pass (UA pool + sec-ch-ua + sec-fetch fingerprints + 403-retry).
//   3. Use whichever combination of {games, players} yields a writable
//      result. Always prefer rolling's games when both populate so we
//      don't drift back into 7-digit DK competition IDs in nba_games.
//   4. Bind player rows to nba_games via team-abbr lookup (same as before).
//      Source/method/confidence labels reflect the actual upstream that
//      produced the players for that run, so the admin UI can see the mix.
//
// Two writes per run:
//   1. nba_games (upsert by external_game_id, 10-digit cdn.nba.com IDs).
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

const FUNCTION_VERSION = 5
const PIPELINE = "sync-nba-projections"
const COLLECTION_SLUG = "nba_top_shot"

const ROLLING_ROUTE = "/nba/rolling-projections"
const DK_ROUTE = "/nba/draftkings-projections"

const ROLLING_SOURCE = "nba-stats-rolling5"
const ROLLING_METHOD = "rolling-5-game-fantasy-average"
const DK_SOURCE = "draftkings"
const DK_METHOD = "draftkings-model"

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
  // source label and confidence tier change. We do NOT use DK's games when
  // rolling already produced cdn.nba.com games — DK's 7-digit competition
  // IDs would coexist with the canonical 10-digit IDs in nba_games and
  // pollute downstream joins.
  let dk: ProxyAttempt | null = null
  if (rollingDegraded) {
    dk = await callProxyRoute(DK_ROUTE)
  }

  const dkPlayers = dk?.body?.players ?? []
  const dkGames = dk?.body?.games ?? []

  // Decide what to write. Source picks the players upstream; gamesSource
  // picks which payload's `games` array we upsert from.
  let scraped: ProxyPlayer[] = []
  let proxyGames: ProxyGame[] = []
  let activeSource = ROLLING_SOURCE
  let activeMethod = ROLLING_METHOD
  let activeConfidence: "HIGH" | "MEDIUM" | "LOW" = "LOW"
  let viaTag = "rolling"

  if (rolling.ok && rollingPlayers.length > 0) {
    scraped = rollingPlayers
    proxyGames = rollingGames
    activeSource = ROLLING_SOURCE
    activeMethod = ROLLING_METHOD
    activeConfidence = "LOW"
    viaTag = "rolling"
  } else if (dk && dk.ok && dkPlayers.length > 0) {
    scraped = dkPlayers
    // Prefer rolling games (10-digit IDs) when present; fall back to DK
    // games only when rolling 502'd entirely.
    proxyGames = rollingGames.length > 0 ? rollingGames : dkGames
    activeSource = DK_SOURCE
    activeMethod = DK_METHOD
    activeConfidence = "MEDIUM"
    viaTag = rollingGames.length > 0 ? "dk-players+rolling-games" : "dk"
  } else if (rolling.ok) {
    // Rolling worked but had no players, DK didn't help either.
    proxyGames = rollingGames
    viaTag = dk ? "rolling-games-only+dk-failed" : "rolling-games-only"
  } else if (dk && dk.ok) {
    // Rolling 502'd but DK at least returned a games payload (no players).
    proxyGames = dkGames
    viaTag = "dk-games-only"
  }
  // If both failed entirely, scraped + proxyGames stay empty; we still log
  // the run with both errors.

  // Hard-fail only when BOTH upstreams failed AND we have nothing to write.
  if (!rolling.ok && (!dk || !dk.ok)) {
    await logRun({
      startedAt: startedAtIso,
      rowsFound: 0, rowsWritten: 0, rowsSkipped: 0,
      ok: false,
      error: `both_upstreams_failed`,
      extra: {
        function_version: FUNCTION_VERSION,
        game_date: gameDate,
        via: "none",
        rolling_error: rolling.error,
        rolling_status: rolling.status,
        rolling_upstream_status: rolling.upstream_status,
        rolling_body_excerpt: rolling.upstream_body_excerpt,
        dk_error: dk?.error ?? null,
        dk_status: dk?.status ?? null,
        dk_upstream_status: dk?.upstream_status ?? null,
        dk_body_excerpt: dk?.upstream_body_excerpt ?? null,
        elapsed_ms: Date.now() - started,
      },
    })
    return
  }

  const proxy: ProxyResponse = (rolling.body ?? dk?.body) as ProxyResponse

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
      // Confidence tracks the active upstream: DK's model is MEDIUM,
      // stats.nba.com rolling-5 is LOW (noisier stand-in).
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
      fallback_source: DK_SOURCE,
      note: "Real results will appear in pipeline_runs within ~30-60s.",
    }),
    { headers: { "Content-Type": "application/json" } },
  )
})

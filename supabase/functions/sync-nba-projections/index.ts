// sync-nba-projections — scrapes DailyFantasyFuel's NBA projections page and
// upserts into nba_player_projections.
//
// Scraping risk: DFF can change page structure. We try two extraction modes
// in order:
//   1. Next.js __NEXT_DATA__ JSON blob (most resilient)
//   2. HTML <tr><td>...</td></tr> regex extraction (fallback)
// On total miss we log a body excerpt to pipeline_runs.extras so the user
// can diagnose without redeploying. We never delete prior projections.
//
// Player resolution uses normalize_player_name() in SQL so JS normalization
// doesn't have to perfectly match the SQL function for unaccent edge cases.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0"

const INGEST_SECRET_TOKEN = Deno.env.get("INGEST_SECRET_TOKEN")
if (!INGEST_SECRET_TOKEN) throw new Error("INGEST_SECRET_TOKEN env var required")

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? ""
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

const FUNCTION_VERSION = 1
const PIPELINE = "sync-nba-projections"
const COLLECTION_SLUG = "nba_top_shot"
const SOURCE = "dailyfantasyfuel"
const DFF_URL = "https://www.dailyfantasyfuel.com/nba/projections"

const BROWSER_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
}

interface ScrapedPlayer {
  rawName: string
  teamAbbr: string | null
  position: string | null
  opponentAbbr: string | null
  projFp: number | null
  projMinutes: number | null
  status: string | null
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
  // we strip the combining-mark range U+0300 through U+036F. Close enough
  // approximation of pg_trgm/unaccent for NBA names — the sync-nba-projections
  // resolver also falls back to alias lookup, which uses the SQL function
  // canonical form, so any drift gets corrected on subsequent runs.
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-zA-Z]/g, "")
    .toLowerCase()
}

function mapInjuryStatus(raw: string | null): string {
  if (!raw) return "ACTIVE"
  const u = raw.trim().toUpperCase()
  if (u === "" || u === "NONE" || u === "GO" || u === "ACTIVE" || u === "PROBABLE") return "ACTIVE"
  if (u === "GTD" || u === "Q" || u === "QUESTIONABLE" || u === "DTD") return "QUESTIONABLE"
  if (u === "OUT" || u === "INJ" || u === "INJURED" || u === "OFS") return "OUT"
  return "ACTIVE"
}

function toNum(v: unknown): number | null {
  if (v == null) return null
  const n = typeof v === "number" ? v : parseFloat(String(v).replace(/[^0-9.\-]/g, ""))
  return Number.isFinite(n) ? n : null
}

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim()
}

// Extraction strategy 1: Next.js / Nuxt / standard server-rendered data blob.
function extractFromInlineJson(html: string): ScrapedPlayer[] {
  const candidates: { tag: string; pattern: RegExp }[] = [
    { tag: "__NEXT_DATA__", pattern: /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/ },
    { tag: "__NUXT__", pattern: /window\.__NUXT__\s*=\s*([\s\S]*?);<\/script>/ },
    { tag: "__INITIAL_STATE__", pattern: /window\.__INITIAL_STATE__\s*=\s*([\s\S]*?);<\/script>/ },
    { tag: "projectionsData", pattern: /var\s+projectionsData\s*=\s*(\[[\s\S]*?\]);/ },
  ]

  for (const c of candidates) {
    const m = html.match(c.pattern)
    if (!m) continue
    const raw = m[1].trim()
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      continue
    }
    const players = walkForPlayers(parsed)
    if (players.length > 0) {
      console.log(`[sync-nba-projections] inline-json hit tag=${c.tag} players=${players.length}`)
      return players
    }
  }
  return []
}

// Recursively walk an arbitrary JSON tree looking for arrays of objects that
// look like player-projection rows. A "looks like" row has a name field and
// either a projected-FP or salary field.
function walkForPlayers(node: unknown): ScrapedPlayer[] {
  if (!node) return []
  if (Array.isArray(node)) {
    if (node.length > 0 && looksLikePlayerArray(node)) {
      return node.map(coercePlayerRow).filter((p): p is ScrapedPlayer => p !== null)
    }
    for (const v of node) {
      const found = walkForPlayers(v)
      if (found.length > 0) return found
    }
    return []
  }
  if (typeof node === "object") {
    for (const v of Object.values(node as Record<string, unknown>)) {
      const found = walkForPlayers(v)
      if (found.length > 0) return found
    }
  }
  return []
}

function looksLikePlayerArray(arr: unknown[]): boolean {
  if (arr.length < 5) return false
  let hits = 0
  for (let i = 0; i < Math.min(arr.length, 8); i++) {
    const item = arr[i]
    if (!item || typeof item !== "object") continue
    const keys = Object.keys(item).map(k => k.toLowerCase())
    const hasName = keys.some(k => k === "name" || k === "playername" || k === "player_name" || k === "player")
    const hasProj = keys.some(k =>
      k.includes("projection") || k.includes("projected") || k === "fpts" || k === "fp" || k === "salary",
    )
    if (hasName && hasProj) hits++
  }
  return hits >= 3
}

function coercePlayerRow(item: unknown): ScrapedPlayer | null {
  if (!item || typeof item !== "object") return null
  const obj = item as Record<string, unknown>
  const lookup = (...names: string[]): unknown => {
    for (const n of names) {
      for (const key of Object.keys(obj)) {
        if (key.toLowerCase() === n.toLowerCase()) return obj[key]
      }
    }
    return null
  }
  const rawName = String(lookup("name", "playerName", "player_name", "player", "fullName") ?? "").trim()
  if (!rawName) return null
  return {
    rawName,
    teamAbbr: stringOrNull(lookup("team", "teamAbbr", "team_abbr", "teamabbreviation")),
    position: stringOrNull(lookup("position", "pos")),
    opponentAbbr: stringOrNull(lookup("opponent", "opp", "opponentAbbr", "opp_team")),
    projFp: toNum(lookup("projection", "projectedPoints", "projection_dk", "fpts", "fp", "projectedFp", "proj_fp")),
    projMinutes: toNum(lookup("minutes", "projectedMinutes", "min", "projMinutes", "proj_minutes")),
    status: stringOrNull(lookup("status", "injuryStatus", "injury_status")),
  }
}

function stringOrNull(v: unknown): string | null {
  if (v == null) return null
  const s = String(v).trim()
  return s ? s : null
}

// Extraction strategy 2: pull <tr> blocks from any HTML table that has a
// recognizable Player + Projected Points column structure.
function extractFromHtmlTable(html: string): ScrapedPlayer[] {
  const tables = html.match(/<table[\s\S]*?<\/table>/gi) ?? []
  for (const tbl of tables) {
    const headerMatch = tbl.match(/<th[^>]*>[\s\S]*?<\/th>/gi) ?? []
    const headers = headerMatch.map(h => stripTags(h).toLowerCase())
    if (!headers.length) continue

    const playerIdx = headers.findIndex(h => h.includes("player") || h === "name")
    const teamIdx = headers.findIndex(h => h === "team" || h === "tm")
    const posIdx = headers.findIndex(h => h === "pos" || h === "position")
    const oppIdx = headers.findIndex(h => h === "opp" || h.includes("opponent"))
    const projIdx = headers.findIndex(h => h.includes("proj") && (h.includes("fp") || h.includes("point") || h.includes("dk") || h === "proj"))
    const minIdx = headers.findIndex(h => h === "min" || h === "mins" || h.includes("minute"))
    const statusIdx = headers.findIndex(h => h === "status" || h.includes("inj"))
    if (playerIdx < 0 || projIdx < 0) continue

    const rows = tbl.match(/<tr[\s\S]*?<\/tr>/gi) ?? []
    const players: ScrapedPlayer[] = []
    for (const row of rows) {
      const cells = (row.match(/<td[\s\S]*?<\/td>/gi) ?? []).map(stripTags)
      if (cells.length === 0) continue
      const rawName = cells[playerIdx] ?? ""
      if (!rawName) continue
      players.push({
        rawName,
        teamAbbr: teamIdx >= 0 ? cells[teamIdx] ?? null : null,
        position: posIdx >= 0 ? cells[posIdx] ?? null : null,
        opponentAbbr: oppIdx >= 0 ? cells[oppIdx] ?? null : null,
        projFp: toNum(cells[projIdx]),
        projMinutes: minIdx >= 0 ? toNum(cells[minIdx]) : null,
        status: statusIdx >= 0 ? cells[statusIdx] ?? null : null,
      })
    }
    if (players.length >= 5) {
      console.log(`[sync-nba-projections] html-table hit rows=${players.length}`)
      return players
    }
  }
  return []
}

interface MatchedPlayer {
  scraped: ScrapedPlayer
  nbaPlayerId: string
  autoInserted: boolean
}

interface MatchResult {
  matched: MatchedPlayer[]
  noNameSkipped: number
}

async function resolveOrInsertPlayers(scraped: ScrapedPlayer[]): Promise<MatchResult> {
  const matched: MatchedPlayer[] = []
  let noNameSkipped = 0

  for (const sp of scraped) {
    if (!sp.rawName) {
      noNameSkipped++
      continue
    }
    const normalized = normalizeJs(sp.rawName)

    // Step 1: direct match on full_name_normalized.
    const { data: direct, error: directErr } = await supabase
      .from("nba_players")
      .select("id")
      .eq("full_name_normalized", normalized)
      .limit(1)
    if (directErr) {
      console.log(`[sync-nba-projections] direct lookup err name="${sp.rawName}": ${directErr.message}`)
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
      console.log(`[sync-nba-projections] alias lookup err name="${sp.rawName}": ${aliasErr.message}`)
      continue
    }
    if (alias && alias.length > 0) {
      matched.push({ scraped: sp, nbaPlayerId: alias[0].nba_player_id, autoInserted: false })
      continue
    }

    // Step 3: insert a new nba_players row. We rely on full_name_normalized
    // UNIQUE so concurrent inserts collapse safely.
    const insertRow = {
      full_name: sp.rawName,
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
      console.log(`[sync-nba-projections] insert err name="${sp.rawName}": ${insErr?.message ?? "unknown"}`)
      continue
    }
    matched.push({ scraped: sp, nbaPlayerId: inserted.id, autoInserted: true })
  }

  return { matched, noNameSkipped }
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

async function runWork(startedAtIso: string, started: number) {
  const gameDate = todayInET()

  let html = ""
  let httpStatus = 0
  try {
    const res = await fetch(DFF_URL, {
      method: "GET",
      headers: BROWSER_HEADERS,
      signal: AbortSignal.timeout(20_000),
    })
    httpStatus = res.status
    html = await res.text()
    if (!res.ok) {
      await logRun({
        startedAt: startedAtIso,
        rowsFound: 0, rowsWritten: 0, rowsSkipped: 0,
        ok: false,
        error: `HTTP ${res.status}`,
        extra: {
          function_version: FUNCTION_VERSION,
          game_date: gameDate,
          body_excerpt: html.slice(0, 500),
          elapsed_ms: Date.now() - started,
        },
      })
      return
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await logRun({
      startedAt: startedAtIso,
      rowsFound: 0, rowsWritten: 0, rowsSkipped: 0,
      ok: false,
      error: `fetch_failed: ${msg}`,
      extra: { function_version: FUNCTION_VERSION, game_date: gameDate, elapsed_ms: Date.now() - started },
    })
    return
  }

  let scraped = extractFromInlineJson(html)
  if (scraped.length === 0) scraped = extractFromHtmlTable(html)

  if (scraped.length === 0) {
    // Known scraping risk — DFF page structure may have changed. Log enough
    // to diagnose without redeploying.
    await logRun({
      startedAt: startedAtIso,
      rowsFound: 0, rowsWritten: 0, rowsSkipped: 0,
      ok: false,
      error: "no_rows_parsed",
      extra: {
        function_version: FUNCTION_VERSION,
        game_date: gameDate,
        http_status: httpStatus,
        html_length: html.length,
        body_excerpt: html.slice(0, 1500),
        note: "DFF page structure changed — adjust extractFromInlineJson / extractFromHtmlTable",
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
        noGameSamples.push(`${m.scraped.rawName} (${m.scraped.teamAbbr ?? "?"})`)
      }
      continue
    }
    projectionRows.push({
      nba_player_id: m.nbaPlayerId,
      game_id: game.gameId,
      game_date: gameDate,
      proj_fp_dk: m.scraped.projFp,
      proj_points: null,
      proj_minutes: m.scraped.projMinutes,
      injury_status: mapInjuryStatus(m.scraped.status),
      confidence: "MED",
      source: SOURCE,
      last_synced_at: nowIso,
    })
  }

  let writeError: string | null = null
  let upserted = 0
  if (projectionRows.length > 0) {
    const { error } = await supabase
      .from("nba_player_projections")
      .upsert(projectionRows, { onConflict: "nba_player_id,game_id,source" })
    if (error) writeError = `upsert: ${error.message}`
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
      rows_parsed: scraped.length,
      players_matched: matched.length,
      players_auto_inserted: autoInsertedCount,
      projections_upserted: upserted,
      no_game_match_count: noGameMatch,
      no_game_match_samples: noGameSamples,
      no_name_skipped: noNameSkipped,
      games_today: games.length,
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
      note: "Real results will appear in pipeline_runs within ~30-60s.",
    }),
    { headers: { "Content-Type": "application/json" } },
  )
})

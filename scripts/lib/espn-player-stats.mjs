// scripts/lib/espn-player-stats.mjs — the pure half of the ESPN stats feed
// (batch 47, 2026-09-25; search v2 + WNBA in batch 56). Plain JS so the
// GitHub Actions runner script can import it without a build; vitest imports
// it the same way.
//
// ESPN's public JSON, measured 2026-09-25 from the cloud sandbox:
//   site.web.api.espn.com/apis/common/v3/sports/<sport>/<espn league>/athletes/<id>/stats
//     → { filters: [{name:'seasontype', value:'2'}…], categories: [{ name, displayName,
//          labels[], names[], statistics: [{ season:{year, displayName}, teamSlug, stats[] }] }] }
//     serves a RETIRED id (Paul Pierce 662 → 19 seasons) and a WNBA id under
//     basketball/wnba (A'ja Wilson 3149391 → 9 calendar-year seasons).
//   site.web.api.espn.com/apis/search/v2?query=<name>&type=player&limit=N
//     → { results: [{ type:'player', contents: [{ uid:'s:40~l:46~a:662', displayName,
//          defaultLeagueSlug:'nba'|'wnba'|'nfl'|'college-football'…, sport, subtitle:<team> }] }] }
//     ⚠ the older /apis/common/v3/search (batch 47) returns ACTIVE players only
//     and no WNBA under sport=basketball — 64 Top Shot names came back empty.

export const ESPN_SPORT = { nfl: "football", nba: "basketball" }
/** The ESPN leagues an identity league may be keyed in (Top Shot mints WNBA moments). */
export const ESPN_LEAGUES = { nfl: ["nfl"], nba: ["nba", "wnba"] }
/**
 * A search hit's league that is really another: ESPN files a player on a
 * G League roster under `nba-development` (Fultz on Raptors 905, Oladipo on
 * the Charge — measured 2026-09-25) with the SAME athlete id, and
 * basketball/nba/athletes/<id>/stats serves their NBA seasons.
 */
export const ESPN_LEAGUE_ALIASES = { "nba-development": "nba" }

export function espnStatsUrl(league, espnId, espnLeague = league) {
  const sport = ESPN_SPORT[league]
  if (!sport) throw new Error(`espnStatsUrl: unknown league ${league}`)
  const el = String(espnLeague || league)
  if (!ESPN_LEAGUES[league].includes(el)) throw new Error(`espnStatsUrl: ${el} is not an ESPN league of ${league}`)
  return `https://site.web.api.espn.com/apis/common/v3/sports/${sport}/${el}/athletes/${encodeURIComponent(espnId)}/stats`
}

export function espnSearchUrl(league, name, limit = 10) {
  if (!ESPN_SPORT[league]) throw new Error(`espnSearchUrl: unknown league ${league}`)
  const q = new URLSearchParams({ query: name, type: "player", limit: String(limit) })
  return `https://site.web.api.espn.com/apis/search/v2?${q.toString()}`
}

/** "stephen-curry" → "stephen curry": an alias slug as a search query. */
export function slugToQuery(slug) {
  return String(slug ?? "").replace(/-+/g, " ").trim()
}

/** The stat-line rows upsert_player_season_stats takes, from one athlete's /stats payload. */
export function parseEspnStats(payload, espnId) {
  if (!payload || typeof payload !== "object") throw new Error("parseEspnStats: payload is not an object")
  const filters = Array.isArray(payload.filters) ? payload.filters : null
  let cats = Array.isArray(payload.categories) ? payload.categories : null
  if (cats === null) {
    // ESPN's shape for an athlete with NO stat lines (an offensive lineman, a
    // practice-squad id — measured 2026-09-25 on nfl 14924 / 4429955 / 16790)
    // is { filters:[{name:'league',…}] } with no categories at all. The
    // filters array is the positive control that ESPN ANSWERED; a payload
    // with neither is a changed upstream and stays a failed read.
    const answered = filters !== null && filters.some((f) => f && typeof f === "object" && typeof f.name === "string")
    if (!answered) throw new Error("parseEspnStats: no categories array")
    cats = []
  }
  const st = (filters ?? []).find((f) => f && f.name === "seasontype")
  const seasonType = st && Number.isInteger(Number(st.value)) ? Number(st.value) : 2

  const rows = []
  const seen = new Set()
  for (const c of cats) {
    if (!c || typeof c.name !== "string" || c.name === "") continue
    const labels = Array.isArray(c.labels) ? c.labels.map(String) : null
    const names = Array.isArray(c.names) ? c.names.map(String) : null
    if (!labels || !names) continue
    for (const s of Array.isArray(c.statistics) ? c.statistics : []) {
      const year = s && s.season && Number(s.season.year)
      if (!Number.isInteger(year)) continue
      const values = Array.isArray(s.stats) ? s.stats.map((v) => (v == null ? "" : String(v))) : null
      if (!values || values.length !== labels.length) continue
      // A traded season comes as one line PER TEAM plus a "<year> Totals" line
      // (teamId null, teamSlug "2024 Totals"). The total is keyed on team_slug ''
      // and flagged; per-team lines keep their slug. Measured 2026-09-25 (Adams).
      const rawSlug = typeof s.teamSlug === "string" ? s.teamSlug.trim() : ""
      // a real slug never carries a space; the totals "slug" is "<year> Totals"
      const isTotal = /totals?$/i.test(rawSlug) || / /.test(rawSlug)
      const teamSlug = isTotal || rawSlug === "" ? "" : rawSlug
      const key = `${year}|${c.name}|${teamSlug}`
      if (seen.has(key)) continue
      seen.add(key)
      rows.push({
        espn_id: String(espnId),
        season: year,
        season_type: seasonType,
        category: c.name,
        display_name: typeof c.displayName === "string" ? c.displayName : null,
        team_slug: teamSlug === "" ? null : teamSlug,
        is_total: isTotal,
        labels,
        names,
        values,
      })
    }
  }
  return rows
}

/** Accent-, case- and punctuation-folded, generational suffix removed — the crosswalk's base slug. */
export function baseSlug(name) {
  const s = String(name ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
  return s.replace(/-(jr|sr|ii|iii|iv|v)-?$/, "")
}

/**
 * The player hits of a /apis/search/v2 payload, flattened: { id, displayName,
 * league, sport, team }. The athlete id is the `a:` segment of `uid`
 * (s:40~l:46~a:662); a hit without one is skipped. Tolerates the batch-47
 * `items` shape too.
 */
export function espnSearchHits(payload) {
  const out = []
  const push = (c) => {
    if (!c || typeof c !== "object") return
    if (c.type && c.type !== "player") return
    let id = c.id != null && /^\d+$/.test(String(c.id)) ? String(c.id) : null
    const m = typeof c.uid === "string" ? c.uid.match(/~a:(\d+)/) : null
    if (m) id = m[1]
    if (!id) return
    out.push({
      id,
      displayName: String(c.displayName ?? ""),
      league: (() => { const l = String(c.defaultLeagueSlug ?? c.league ?? "").toLowerCase(); return ESPN_LEAGUE_ALIASES[l] ?? l })(),
      sport: String(c.sport ?? "").toLowerCase(),
      team: typeof c.subtitle === "string" ? c.subtitle : null,
    })
  }
  if (payload && Array.isArray(payload.results)) {
    for (const r of payload.results) for (const c of Array.isArray(r?.contents) ? r.contents : []) push(c)
  } else if (payload && Array.isArray(payload.items)) {
    for (const c of payload.items) push(c)
  } else if (Array.isArray(payload)) {
    for (const c of payload) push(c)
  }
  return out
}

/**
 * Pick the ONE ESPN athlete for a display name from a search payload: an ESPN
 * league of this identity league (nba → nba or wnba), base name equal.
 * Exactly one → { espn_id, espn_league, matched_by }; none or several →
 * { espn_id: null, espn_league: null, matched_by: 'unresolved:none' |
 * 'unresolved:ambiguous:N' }. A same-base-name tie is broken by the exact
 * spelling when unique — never by league or team.
 */
export function matchEspnSearch(payload, league, displayName) {
  const want = baseSlug(displayName)
  const leagues = ESPN_LEAGUES[league] ?? [league]
  const sport = ESPN_SPORT[league]
  const named = espnSearchHits(payload).filter(
    (h) => (!sport || !h.sport || h.sport === sport) && baseSlug(h.displayName) === want,
  )
  const hits = named.filter((h) => leagues.includes(h.league))
  // A same-name hit ESPN files under another PRO league of the sport — a
  // player now abroad reads `fiba` / `nbl` / `womens-olympics-basketball`
  // (Patty Mills, Boris Diaw, Dario Saric, Julie Vanloo — measured 2026-09-25)
  // with the SAME athlete id the nba / wnba stats path serves. Never taken
  // by name alone: the runner probes each one's stats and takes the ONE that
  // has seasons. College leagues are never candidates.
  const probe = named.filter((h) => !leagues.includes(h.league) && h.league !== "" && !/college/.test(h.league))
  const cand = (list) => list.map((h) => ({ id: h.id, league: h.league, displayName: h.displayName, team: h.team }))
  if (hits.length === 1) return { espn_id: hits[0].id, espn_league: hits[0].league, matched_by: "espn-search:name", candidates: [] }
  if (hits.length === 0) return { espn_id: null, espn_league: null, matched_by: "unresolved:none", candidates: cand(probe) }
  // several with the same base name: an exact spelling wins when unique
  const exact = hits.filter((h) => h.displayName.trim() === String(displayName).trim())
  if (exact.length === 1) return { espn_id: exact[0].id, espn_league: exact[0].league, matched_by: "espn-search:exact", candidates: [] }
  return { espn_id: null, espn_league: null, matched_by: `unresolved:ambiguous:${hits.length}`, candidates: cand(hits) }
}

/**
 * The verdict of a stats PROBE over search candidates: `probed` is one entry
 * per (candidate, espn league) tried with the season count its stats page
 * showed (0 for an answered empty). Exactly one candidate with seasons is
 * the person; none or several is still unresolved — a duplicate ESPN entry
 * (a G League affiliate copy, a phantom with no team) has no seasons, two
 * real players both do.
 */
export function pickProbedCandidate(probed) {
  const withSeasons = new Map()
  for (const p of Array.isArray(probed) ? probed : []) {
    if (!p || !p.id || !(p.seasons > 0)) continue
    if (!withSeasons.has(p.id)) withSeasons.set(p.id, p.espn_league)
  }
  if (withSeasons.size === 1) {
    const [id, espn_league] = [...withSeasons.entries()][0]
    return { espn_id: id, espn_league, matched_by: "espn-search:stats-probe" }
  }
  return { espn_id: null, espn_league: null, matched_by: withSeasons.size === 0 ? "unresolved:none" : `unresolved:ambiguous:${withSeasons.size}` }
}

export function chunk(arr, size) {
  if (!(size > 0)) throw new Error("chunk: size must be positive")
  const out = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

// scripts/lib/espn-player-stats.mjs — the pure half of the ESPN stats feed
// (batch 47, 2026-09-25). Plain JS so the GitHub Actions runner script can
// import it without a build; vitest imports it the same way.
//
// ESPN's public JSON, measured 2026-09-25 from the cloud sandbox:
//   site.web.api.espn.com/apis/common/v3/sports/<sport>/<league>/athletes/<id>/stats
//     → { filters: [{name:'seasontype', value:'2'}…], categories: [{ name, displayName,
//          labels[], names[], statistics: [{ season:{year, displayName}, teamSlug, stats[] }] }] }
//   site.web.api.espn.com/apis/common/v3/search?query=<name>&type=player&sport=<sport>
//     → { items: [{ id, displayName, sport, league, … }] }

export const ESPN_SPORT = { nfl: "football", nba: "basketball" }

export function espnStatsUrl(league, espnId) {
  const sport = ESPN_SPORT[league]
  if (!sport) throw new Error(`espnStatsUrl: unknown league ${league}`)
  return `https://site.web.api.espn.com/apis/common/v3/sports/${sport}/${league}/athletes/${encodeURIComponent(espnId)}/stats`
}

export function espnSearchUrl(league, name, limit = 10) {
  const sport = ESPN_SPORT[league]
  if (!sport) throw new Error(`espnSearchUrl: unknown league ${league}`)
  const q = new URLSearchParams({ query: name, type: "player", sport, limit: String(limit) })
  return `https://site.web.api.espn.com/apis/common/v3/search?${q.toString()}`
}

/** The stat-line rows upsert_player_season_stats takes, from one athlete's /stats payload. */
export function parseEspnStats(payload, espnId) {
  if (!payload || typeof payload !== "object") throw new Error("parseEspnStats: payload is not an object")
  const cats = Array.isArray(payload.categories) ? payload.categories : null
  if (cats === null) throw new Error("parseEspnStats: no categories array")
  const filters = Array.isArray(payload.filters) ? payload.filters : []
  const st = filters.find((f) => f && f.name === "seasontype")
  const seasonType = st && Number.isInteger(Number(st.value)) ? Number(st.value) : 2

  const rows = []
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
      rows.push({
        espn_id: String(espnId),
        season: year,
        season_type: seasonType,
        category: c.name,
        display_name: typeof c.displayName === "string" ? c.displayName : null,
        team_slug: typeof s.teamSlug === "string" && s.teamSlug !== "" ? s.teamSlug : null,
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
 * Pick the ONE ESPN athlete for a display name from a search result: same
 * league, base name equal. Exactly one → { espn_id, matched_by }; none or
 * several → { espn_id: null, matched_by: 'unresolved:none' | 'unresolved:ambiguous' }.
 */
export function matchEspnSearch(items, league, displayName) {
  const want = baseSlug(displayName)
  const list = Array.isArray(items) ? items : []
  const hits = list.filter(
    (i) => i && String(i.league ?? "").toLowerCase() === league && i.id != null && baseSlug(i.displayName) === want,
  )
  if (hits.length === 1) return { espn_id: String(hits[0].id), matched_by: "espn-search:name" }
  if (hits.length === 0) return { espn_id: null, matched_by: "unresolved:none" }
  // several with the same base name: an exact spelling wins when unique
  const exact = hits.filter((i) => String(i.displayName).trim() === String(displayName).trim())
  if (exact.length === 1) return { espn_id: String(exact[0].id), matched_by: "espn-search:exact" }
  return { espn_id: null, matched_by: `unresolved:ambiguous:${hits.length}` }
}

export function chunk(arr, size) {
  if (!(size > 0)) throw new Error("chunk: size must be positive")
  const out = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

// lib/player-page-season-stats.ts — the view-model for the player page's
// "Season stats" section (batch 48, 2026-09-25). Pure: takes what
// get_player_season_stats returns and shapes it for the table; no I/O.
//
// The RPC's three states are preserved, not collapsed:
//   · NULL       → the feed cannot key this player (no identity / no ESPN id)
//                  → the section is NOT rendered (an absence, never a claim)
//   · rows: []   → keyed, nothing fetched yet → "no stats from the feed yet"
//   · rows       → tables, one per category, seasons newest first
// A FAILED read never reaches this module — the page renders SectionUnavailable.

export interface SeasonStatRow {
  season: number
  season_type: number
  category: string
  display_name: string | null
  team_slug: string | null
  labels: string[]
  names: string[]
  values: string[]
}

export interface SeasonStatsResult {
  league: "nba" | "nfl" | string
  espn_id: string
  display_name: string | null
  stats_refreshed_at: string | null
  rows_refreshed_at: string | null
  rows: SeasonStatRow[]
}

export interface SeasonStatsTable {
  category: string
  title: string
  /** Column headers, ESPN's labels (GP, YDS, …) */
  labels: string[]
  /** One row per season, newest first */
  seasons: Array<{ season: number; seasonLabel: string; team: string | null; values: string[] }>
}

/** The order categories are shown in; anything else follows, in ESPN's order. */
const CATEGORY_ORDER: Record<string, string[]> = {
  nba: ["averages", "totals", "miscellaneous"],
  nfl: ["passing", "rushing", "receiving", "defensive", "defensiveInterceptions", "kicking", "punting", "returning", "scoring", "general"],
}

/** "kansas-city-chiefs" → "Kansas City Chiefs"; "49ers" stays "49ers". */
export function teamSlugLabel(slug: string | null | undefined): string | null {
  if (!slug) return null
  return slug
    .split("-")
    .filter(Boolean)
    .map((w) => (/^[a-z]/.test(w) ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ")
}

/** NBA seasons are labelled "2024-25" for ESPN's year 2025; NFL by the year. */
export function seasonLabel(league: string, season: number): string {
  if (league === "nba") return `${season - 1}-${String(season).slice(-2)}`
  return String(season)
}

export function buildSeasonStatsTables(result: SeasonStatsResult): SeasonStatsTable[] {
  const order = CATEGORY_ORDER[result.league] ?? []
  const byCat = new Map<string, SeasonStatRow[]>()
  for (const r of result.rows) {
    if (!Array.isArray(r.labels) || !Array.isArray(r.values) || r.labels.length !== r.values.length) continue
    const list = byCat.get(r.category) ?? []
    list.push(r)
    byCat.set(r.category, list)
  }
  const cats = [...byCat.keys()].sort((a, b) => {
    const ia = order.indexOf(a)
    const ib = order.indexOf(b)
    const ra = ia === -1 ? order.length : ia
    const rb = ib === -1 ? order.length : ib
    return ra - rb || a.localeCompare(b)
  })
  const tables: SeasonStatsTable[] = []
  for (const cat of cats) {
    const rows = (byCat.get(cat) ?? []).slice().sort((a, b) => b.season - a.season)
    // a category's label set can differ between seasons (ESPN adds columns);
    // the table is keyed on the newest season's labels and older seasons map by name
    const head = rows[0]
    const labels = head.labels
    const seasons = rows.map((r) => {
      const values = labels.map((_, i) => {
        const name = head.names[i]
        const j = r.names.indexOf(name)
        return j === -1 ? "—" : (r.values[j] ?? "—")
      })
      return { season: r.season, seasonLabel: seasonLabel(result.league, r.season), team: teamSlugLabel(r.team_slug), values }
    })
    tables.push({ category: cat, title: head.display_name ?? cat, labels, seasons })
  }
  return tables
}

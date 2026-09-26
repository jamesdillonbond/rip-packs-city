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
  /** A traded season's "<year> Totals" line (ESPN gives one line per team plus this). */
  is_total?: boolean
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
    const all = (byCat.get(cat) ?? []).slice().sort((a, b) => b.season - a.season)
    // A traded season arrives as one line per team plus a totals line: show the
    // total (labelled with both teams) and drop the per-team lines; a season
    // with per-team lines and NO total keeps every line, each named by team.
    const rows: Array<{ row: SeasonStatRow; team: string | null }> = []
    const bySeason = new Map<number, SeasonStatRow[]>()
    for (const r of all) bySeason.set(r.season, [...(bySeason.get(r.season) ?? []), r])
    for (const [season, lines] of [...bySeason.entries()].sort((a, b) => b[0] - a[0])) {
      const total = lines.find((l) => l.is_total === true)
      if (total) {
        const teams = lines.filter((l) => l !== total && l.team_slug).map((l) => teamSlugLabel(l.team_slug)).filter(Boolean) as string[]
        rows.push({ row: total, team: teams.length ? teams.join(" / ") : null })
      } else {
        for (const l of lines) rows.push({ row: l, team: teamSlugLabel(l.team_slug) })
      }
      void season
    }
    if (rows.length === 0) continue
    // a category's label set can differ between seasons (ESPN adds columns);
    // the table is keyed on the newest season's labels and older seasons map by name
    const head = rows[0].row
    const labels = head.labels
    const seasons = rows.map(({ row: r, team }) => {
      const values = labels.map((_, i) => {
        const name = head.names[i]
        const j = r.names.indexOf(name)
        return j === -1 ? "—" : (r.values[j] ?? "—")
      })
      return { season: r.season, seasonLabel: seasonLabel(result.league, r.season), team, values }
    })
    tables.push({ category: cat, title: head.display_name ?? cat, labels, seasons })
  }
  return tables
}

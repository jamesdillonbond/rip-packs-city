// lib/slab-stats.ts — what the back of the interactive Moment slab says about the player.
//
// 2026-11-25 (Trevor: "The back of the slab should show their stats that season and anything
// else relevant"). Two blocks, both from ESPN via tables RPC already keeps:
//   · THIS GAME — the player's line from the game the Moment comes from (get_moment_game_context
//     → player_gamelog_lines, or the box-score lane's player_game_stats for recent games).
//   · SEASON   — the player's averages / totals for the season that game belongs to
//     (player_season_stats, through get_moment_game_context or get_player_season_stats).
//
// Pure: shapes rows into chips; no I/O. A block with nothing real in it is NOT rendered — an
// absence, never a row of zeros (a wide receiver's ESPN "Passing" line of zeros is not a stat).

import { isZeroLike, seasonLabel, teamSlugLabel } from "@/lib/player-page-season-stats"

export type EspnLeague = "nba" | "wnba" | "nfl"

export interface StatChip {
  label: string
  value: string
  /** This game's number beat the player's average for the season (basketball PTS / REB / AST). */
  aboveAverage?: boolean
}

export interface SlabStatBlock {
  /** "This game" / "2024-25 season" */
  title: string
  /** "vs ORL · W 114-109 · Dec 10, 2024" / "Milwaukee Bucks · 58 games" */
  detail: string | null
  chips: StatChip[]
  /** ESPN's game page for this game (the box score), when the game is known by ESPN's id. */
  link?: string | null
}

export interface SlabStats {
  game: SlabStatBlock | null
  season: SlabStatBlock | null
}

/** A player_season_stats line as get_moment_game_context / get_player_season_stats return it. */
export interface SeasonLine {
  category: string
  team_slug?: string | null
  is_total?: boolean | null
  labels: string[]
  names: string[]
  values: string[]
  season?: number
}

export interface GamelogGame {
  source: "gamelog"
  event_id?: string | null
  game_date?: string | null
  season_type?: string | null
  at_vs?: string | null
  opponent_abbr?: string | null
  score?: string | null
  result?: string | null
  names: string[]
  values: string[]
}

export interface BoxGame {
  source: "box"
  event_id?: string | null
  game_date?: string | null
  at_vs?: string | null
  opponent_abbr?: string | null
  did_not_play?: boolean | null
  stats: Record<string, string>
}

/** A TEAM Moment's game (20261126161848): the subject team's result, no player line. */
export interface TeamGame {
  source: "team"
  event_id?: string | null
  game_date?: string | null
  season_type?: string | null
  at_vs?: string | null
  opponent_abbr?: string | null
  score?: string | null
  result?: string | null
}

/** A LaLiga Golazos Moment's match (20261126170312), from ESPN's LaLiga scoreboard. */
export interface MatchGame {
  source: "match"
  event_id?: string | null
  game_date?: string | null
  home_name?: string | null
  away_name?: string | null
  home_score?: number | null
  away_score?: number | null
  /** The side the Moment's player played for, from the edition's own record; null when unknown. */
  side?: "home" | "away" | null
}

export interface MomentGameContext {
  league?: string
  espn_league: string
  season: number
  moment_game_date?: string | null
  season_rows: SeasonLine[]
  game: GamelogGame | BoxGame | TeamGame | MatchGame | null
}

export function asEspnLeague(v: unknown): EspnLeague | null {
  return v === "nba" || v === "wnba" || v === "nfl" ? v : null
}

/**
 * ESPN's season number for a game on `isoDate` — the same rule as SQL moment_gamelog_season:
 * NBA seasons are numbered by the year they END (Oct 2024 → 2025); the WNBA by the calendar year;
 * NFL by the year they START (a February Super Bowl belongs to the previous year).
 */
export function momentSeason(league: EspnLeague, isoDate: string): number | null {
  const m = /^(\d{4})-(\d{2})-\d{2}/.exec(isoDate ?? "")
  if (!m) return null
  const y = Number(m[1])
  const mo = Number(m[2])
  if (league === "nba") return mo >= 8 ? y + 1 : y
  if (league === "wnba") return y
  return mo <= 3 ? y - 1 : y
}

function valueOf(names: string[], values: string[], name: string): string | null {
  const i = names.indexOf(name)
  if (i === -1) return null
  const v = values[i]
  return v == null || String(v).trim() === "" ? null : String(v).trim()
}

function num(v: string | null): number | null {
  if (v == null) return null
  const n = Number(String(v).replace(/,/g, ""))
  return Number.isFinite(n) ? n : null
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
/** "2024-12-10" → "Dec 10, 2024" — a calendar date, never shifted through a clock zone. */
export function plainDate(iso: string | null | undefined): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? "")
  if (!m) return null
  return `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}`
}

type Pick = { name: string; label: string; keepZero?: boolean }

function chipsFrom(names: string[], values: string[], picks: Pick[], max = 5): StatChip[] {
  const out: StatChip[] = []
  for (const p of picks) {
    if (out.length >= max) break
    const v = valueOf(names, values, p.name)
    if (v == null) continue
    if (!p.keepZero && isZeroLike(v)) continue
    out.push({ label: p.label, value: v })
  }
  return out
}

// ── basketball ───────────────────────────────────────────────────────────────

const BASKETBALL_GAME: Pick[] = [
  { name: "points", label: "PTS", keepZero: true },
  { name: "totalRebounds", label: "REB", keepZero: true },
  { name: "rebounds", label: "REB", keepZero: true },
  { name: "assists", label: "AST", keepZero: true },
  { name: "fieldGoalsMade-fieldGoalsAttempted", label: "FG" },
  { name: "threePointFieldGoalsMade-threePointFieldGoalsAttempted", label: "3PT" },
  { name: "steals", label: "STL" },
  { name: "blocks", label: "BLK" },
]

const BASKETBALL_SEASON: Pick[] = [
  { name: "avgPoints", label: "PPG", keepZero: true },
  { name: "avgRebounds", label: "RPG", keepZero: true },
  { name: "avgAssists", label: "APG", keepZero: true },
  { name: "fieldGoalPct", label: "FG%" },
  { name: "threePointFieldGoalPct", label: "3P%" },
]

// ── football ────────────────────────────────────────────────────────────────
// ESPN's NFL labels repeat ("YDS" for passing AND rushing), so every chip is named by RPC.

function footballGameChips(names: string[], values: string[]): StatChip[] {
  const n = (k: string) => num(valueOf(names, values, k))
  const v = (k: string) => valueOf(names, values, k)
  const chips: StatChip[] = []
  if ((n("passingAttempts") ?? 0) > 0) {
    const cmp = v("completions")
    const att = v("passingAttempts")
    if (cmp && att) chips.push({ label: "C/ATT", value: `${cmp}/${att}` })
    if (v("passingYards") != null) chips.push({ label: "PASS YDS", value: v("passingYards") as string })
    if (v("passingTouchdowns") != null) chips.push({ label: "PASS TD", value: v("passingTouchdowns") as string })
    if ((n("interceptions") ?? 0) > 0) chips.push({ label: "INT", value: v("interceptions") as string })
  }
  if ((n("rushingAttempts") ?? 0) > 0) {
    if (v("rushingYards") != null) chips.push({ label: "RUSH YDS", value: v("rushingYards") as string })
    if ((n("rushingTouchdowns") ?? 0) > 0) chips.push({ label: "RUSH TD", value: v("rushingTouchdowns") as string })
  }
  if ((n("receptions") ?? 0) > 0 || (n("receivingYards") ?? 0) > 0) {
    if (v("receptions") != null) chips.push({ label: "REC", value: v("receptions") as string })
    if (v("receivingYards") != null) chips.push({ label: "REC YDS", value: v("receivingYards") as string })
    if ((n("receivingTouchdowns") ?? 0) > 0) chips.push({ label: "REC TD", value: v("receivingTouchdowns") as string })
  }
  if (chips.length === 0) {
    // a defender's line
    chips.push(...chipsFrom(names, values, [
      { name: "totalTackles", label: "TKL" },
      { name: "sacks", label: "SACK" },
      { name: "interceptions", label: "INT" },
      { name: "passesDefended", label: "PD" },
      { name: "fumblesForced", label: "FF" },
    ]))
  }
  return chips.slice(0, 5)
}

/** The NFL categories that make up a season, in the order they lead the block. */
const FOOTBALL_SEASON: Array<{ category: string; picks: Pick[]; leadsWhen: string }> = [
  { category: "passing", leadsWhen: "passingAttempts", picks: [
    { name: "passingYards", label: "PASS YDS" },
    { name: "passingTouchdowns", label: "PASS TD" },
    { name: "interceptions", label: "INT" },
    { name: "QBRating", label: "RTG" },
  ] },
  { category: "rushing", leadsWhen: "rushingAttempts", picks: [
    { name: "rushingYards", label: "RUSH YDS" },
    { name: "rushingTouchdowns", label: "RUSH TD" },
  ] },
  { category: "receiving", leadsWhen: "receptions", picks: [
    { name: "receptions", label: "REC" },
    { name: "receivingYards", label: "REC YDS" },
    { name: "receivingTouchdowns", label: "REC TD" },
  ] },
  { category: "defensive", leadsWhen: "totalTackles", picks: [
    { name: "totalTackles", label: "TKL" },
    { name: "sacks", label: "SACK" },
    { name: "interceptions", label: "INT" },
    { name: "passesDefended", label: "PD" },
  ] },
]

const OFFENSE_YARDS: Record<string, string> = { passing: "passingYards", rushing: "rushingYards", receiving: "receivingYards" }

function footballSeasonChips(rows: SeasonLine[]): StatChip[] {
  const byCat = new Map(rows.map((r) => [r.category, r]))
  // The position the season was about leads: the category with the most volume.
  const ranked = FOOTBALL_SEASON
    .map((f) => {
      const r = byCat.get(f.category)
      const vol = r ? num(valueOf(r.names, r.values, f.leadsWhen)) ?? 0 : 0
      return { f, r, vol }
    })
    .filter((x) => x.r && x.vol > 0)
    .sort((a, b) => b.vol - a.vol)
  // The leading category decides the side of the ball. Defense joins only when it leads (one
  // special-teams tackle is not a receiver's stat); another offensive category joins only with at
  // least a tenth of the lead's yards (a mobile QB's rushing, an RB's receiving — not a WR's two
  // carries).
  const lead = ranked[0]
  const yards = (x: (typeof ranked)[number]) => {
    const y = OFFENSE_YARDS[x.f.category]
    return y ? num(valueOf(x.r!.names, x.r!.values, y)) ?? 0 : 0
  }
  const kept = ranked.filter((x, i) => {
    if (i === 0) return true
    if (lead.f.category === "defensive" || x.f.category === "defensive") return false
    const leadYards = yards(lead)
    return leadYards > 0 && yards(x) >= leadYards * 0.1
  })
  const chips: StatChip[] = []
  for (const { f, r } of kept) {
    for (const c of chipsFrom(r!.names, r!.values, f.picks, 5)) {
      if (chips.length < 5) chips.push(c)
    }
  }
  return chips
}

// ── blocks ──────────────────────────────────────────────────────────────────

export function gameBlock(league: EspnLeague, game: GamelogGame | BoxGame | TeamGame | MatchGame | null | undefined): SlabStatBlock | null {
  if (!game || game.source === "match") return null
  if (game.source === "team") {
    // A team Moment: the result is the line. No result, nothing — never a bare opponent.
    if (!game.result || !game.score) return null
    const opp = game.opponent_abbr ? `${game.at_vs === "@" ? "@" : "vs"} ${game.opponent_abbr}` : null
    const post = /postseason/i.test(game.season_type ?? "") ? "Playoffs" : null
    const detail = [opp, post, plainDate(game.game_date)].filter(Boolean).join(" · ") || null
    return { title: "This game", detail, chips: [{ label: "Final", value: `${game.result} ${game.score}` }], link: espnGameUrl(league, game.event_id) }
  }
  if (game.source === "box" && game.did_not_play) return null
  const names = game.source === "gamelog" ? game.names : Object.keys(game.stats ?? {})
  const values = game.source === "gamelog" ? game.values : Object.values(game.stats ?? {}).map(String)
  if (!Array.isArray(names) || !Array.isArray(values) || names.length !== values.length) return null
  const chips = league === "nfl" ? footballGameChips(names, values) : chipsFrom(names, values, BASKETBALL_GAME)
  // de-duplicate a label both rebound spellings could produce
  const seen = new Set<string>()
  const unique = chips.filter((c) => (seen.has(c.label) ? false : (seen.add(c.label), true)))
  if (unique.length === 0 || unique.every((c) => isZeroLike(c.value))) return null
  const opp = game.opponent_abbr ? `${game.at_vs === "@" ? "@" : "vs"} ${game.opponent_abbr}` : null
  const result = game.source === "gamelog" && game.result && game.score ? `${game.result} ${game.score}` : null
  const post = game.source === "gamelog" && /postseason/i.test(game.season_type ?? "") ? "Playoffs" : null
  const detail = [opp, result, post, plainDate(game.game_date)].filter(Boolean).join(" · ") || null
  return { title: "This game", detail, chips: unique, link: espnGameUrl(league, game.event_id) }
}

/** ESPN's game page — only for an id that is ESPN's numeric event id. */
export function espnGameUrl(league: EspnLeague, eventId: string | null | undefined): string | null {
  if (!eventId || !/^\d{6,12}$/.test(eventId)) return null
  return `https://www.espn.com/${league}/game/_/gameId/${eventId}`
}

/** Basketball game chips that beat the same season's per-game average. */
const ABOVE_AVERAGE: Record<string, string> = { PTS: "PPG", REB: "RPG", AST: "APG" }
export function markAboveAverage(game: SlabStatBlock | null, season: SlabStatBlock | null): SlabStatBlock | null {
  if (!game || !season) return game
  const avg = new Map(season.chips.map((c) => [c.label, num(c.value)]))
  return {
    ...game,
    chips: game.chips.map((c) => {
      const key = ABOVE_AVERAGE[c.label]
      const a = key ? avg.get(key) : null
      const v = num(c.value)
      return key && a != null && v != null && v > a ? { ...c, aboveAverage: true } : c
    }),
  }
}

export function seasonBlock(league: EspnLeague, season: number, rows: SeasonLine[] | null | undefined): SlabStatBlock | null {
  const lines = (rows ?? []).filter((r) => r && Array.isArray(r.names) && Array.isArray(r.values) && r.names.length === r.values.length)
  if (lines.length === 0) return null
  // A traded season: ESPN sends one line per team plus a total. Use the total; name both teams.
  const pick = (cat: string) => {
    const inCat = lines.filter((r) => r.category === cat)
    return inCat.find((r) => r.is_total === true) ?? (inCat.length === 1 ? inCat[0] : null)
  }
  const teamsIn = (cat: string) =>
    Array.from(new Set(lines.filter((r) => r.category === cat && !r.is_total && r.team_slug).map((r) => teamSlugLabel(r.team_slug)).filter(Boolean))) as string[]

  let chips: StatChip[] = []
  let gp: string | null = null
  let teams: string[] = []
  if (league === "nfl") {
    const cats = ["passing", "rushing", "receiving", "defensive"].map((c) => pick(c)).filter(Boolean) as SeasonLine[]
    chips = footballSeasonChips(cats)
    gp = cats.map((r) => valueOf(r.names, r.values, "gamesPlayed")).find((v) => v != null && !isZeroLike(v)) ?? null
    teams = teamsIn(cats[0]?.category ?? "passing")
  } else {
    const avg = pick("averages")
    if (avg) {
      chips = chipsFrom(avg.names, avg.values, BASKETBALL_SEASON)
      gp = valueOf(avg.names, avg.values, "gamesPlayed")
      teams = teamsIn("averages")
      if (teams.length === 0 && avg.team_slug) teams = [teamSlugLabel(avg.team_slug) as string]
    }
  }
  if (chips.length === 0 || chips.every((c) => isZeroLike(c.value))) return null
  const games = gp && !isZeroLike(gp) ? `${gp} ${gp === "1" ? "game" : "games"}` : null
  const detail = [teams.join(" / ") || null, games].filter(Boolean).join(" · ") || null
  return { title: `${seasonLabel(league, season)} season`, detail, chips }
}

/**
 * A Golazos Moment's match: the final from the player's side ("W 6-2", "D 1-1") with the opponent on
 * the detail line, or the plain final ("Real Madrid 2-6 Barcelona") when the side is unknown. No
 * score, nothing — never a bare fixture.
 */
export function matchBlock(m: MatchGame | null | undefined): SlabStatBlock | null {
  if (!m || m.source !== "match") return null
  const hs = m.home_score
  const as = m.away_score
  if (typeof hs !== "number" || typeof as !== "number" || !Number.isFinite(hs) || !Number.isFinite(as)) return null
  const link = m.event_id && /^\d{4,12}$/.test(m.event_id) ? `https://www.espn.com/soccer/match/_/gameId/${m.event_id}` : null
  const date = plainDate(m.game_date)
  if (m.side === "home" || m.side === "away") {
    const own = m.side === "home" ? hs : as
    const opp = m.side === "home" ? as : hs
    const oppName = m.side === "home" ? m.away_name : m.home_name
    const res = own > opp ? "W" : own < opp ? "L" : "D"
    const detail = [oppName ? `${m.side === "home" ? "vs" : "@"} ${oppName}` : null, date].filter(Boolean).join(" · ") || null
    return { title: "This match", detail, chips: [{ label: "Final", value: `${res} ${own}-${opp}` }], link }
  }
  if (!m.home_name || !m.away_name) return null
  return { title: "This match", detail: date, chips: [{ label: "Final", value: `${m.home_name} ${hs}-${as} ${m.away_name}` }], link }
}

/** Everything the slab's back shows about the player, or null when there is nothing real to show. */
export function slabStatsFromContext(ctx: MomentGameContext | null | undefined): SlabStats | null {
  if (!ctx) return null
  if (ctx.espn_league === "laliga") {
    const game = ctx.game && ctx.game.source === "match" ? matchBlock(ctx.game) : null
    return game ? { game, season: null } : null
  }
  const league = asEspnLeague(ctx.espn_league)
  if (!league || !Number.isFinite(ctx.season)) return null
  const season = seasonBlock(league, ctx.season, ctx.season_rows)
  const game = league === "nfl" ? gameBlock(league, ctx.game) : markAboveAverage(gameBlock(league, ctx.game), season)
  if (!game && !season) return null
  return { game, season }
}

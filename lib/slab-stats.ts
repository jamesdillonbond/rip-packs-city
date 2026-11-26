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
/** A card's league: the Moment leagues plus MLB (Candy MLB, Panini baseball). Cards have a season line only — no game. */
export type CardLeague = EspnLeague | "mlb"

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
  /** The link's words — "ESPN box score" unless said otherwise (a UFC card is a fight card). */
  linkLabel?: string | null
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

const MLB_BATTING_SEASON: Pick[] = [
  { name: "avg", label: "AVG", keepZero: true },
  { name: "homeRuns", label: "HR", keepZero: true },
  { name: "RBIs", label: "RBI", keepZero: true },
  { name: "OPS", label: "OPS" },
  { name: "stolenBases", label: "SB" },
]
const MLB_PITCHING_SEASON: Pick[] = [
  { name: "wins", label: "W", keepZero: true },
  { name: "ERA", label: "ERA", keepZero: true },
  { name: "strikeouts", label: "K", keepZero: true },
  { name: "WHIP", label: "WHIP" },
  { name: "saves", label: "SV" },
]
/** A season with fewer at-bats than this is a pitcher's (or a cup of coffee): the pitching line leads. */
const MLB_BATTER_MIN_AB = 50

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

export function seasonBlock(league: CardLeague, season: number, rows: SeasonLine[] | null | undefined): SlabStatBlock | null {
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
  if (league === "mlb") {
    // ESPN files a season's batting under "career-batting" (one line per season). A pitcher's
    // batting line is a handful of at-bats; the pitching line leads unless he really hit.
    const bat = pick("career-batting")
    const pit = pick("pitching")
    const ab = bat ? num(valueOf(bat.names, bat.values, "atBats")) : null
    const useBat = bat != null && (pit == null || (ab != null && ab >= MLB_BATTER_MIN_AB))
    const line = useBat ? bat : pit
    if (line) {
      chips = chipsFrom(line.names, line.values, useBat ? MLB_BATTING_SEASON : MLB_PITCHING_SEASON)
      gp = valueOf(line.names, line.values, "gamesPlayed")
      teams = teamsIn(line.category)
      if (teams.length === 0 && line.team_slug) teams = [teamSlugLabel(line.team_slug) as string]
    }
  } else if (league === "nfl") {
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

/**
 * The season a CARD belongs to, from its set name — a card has no game date. "BC 2021-22 Donruss"
 * is the NBA's 2021-22 season (ESPN 2022); "2022 Leadoff ICONs" is MLB 2022; an NFL "2021 Prizm" is
 * 2021; the WNBA is a calendar year. An NBA set with one year ("2024 Prizm") could be either season,
 * so it is null — never a guess. No year, null.
 */
export function cardSeason(league: CardLeague, setName: string | null | undefined): number | null {
  const t = String(setName ?? "")
  const ranges = Array.from(t.matchAll(/\b((?:19|20)\d{2})\s*[-–/]\s*(\d{2}|(?:19|20)\d{2})\b/g))
  // Two DIFFERENT seasons named ("2020-21 NFT NBA Entertainment - BC 2021-22 Prizm …"): no guess.
  if (new Set(ranges.map((r) => r[1])).size > 1) return null
  const range = ranges[0] ?? null
  if (range) {
    const a = Number(range[1])
    const b = Number(range[2])
    // "2021-22" / "2021-2022" / "1999-00" — the second year must follow the first, or it is not a season.
    const follows = range[2].length === 2 ? b === (a + 1) % 100 : b === a + 1
    if (!follows) return null
    if (league === "nba") return a + 1
    if (league === "nfl") return a
    return null // a two-year label on a calendar-year league is not a season we can name
  }
  const one = /\b((?:19|20)\d{2})\b/.exec(t)
  if (!one) return null
  if (league === "nba") return null
  return Number(one[1])
}

/**
 * The back of a CARD slab (Panini, Candy): that card's season line, when the player has one for
 * the season the card is from. No fallback to another season — on a legend's card, a namesake's
 * current season is the wrong person (docs/reference/player-identity.md, Panini crosswalk caveat).
 */
export function cardSlabStats(league: CardLeague | null, setName: string | null | undefined, rows: Array<SeasonLine & { season: number; season_type?: number }> | null | undefined): SlabStats | null {
  if (!league) return null
  const season = cardSeason(league, setName)
  if (season == null) return null
  const lines = (rows ?? []).filter((r) => r.season === season && (r.season_type == null || r.season_type === 2))
  const block = seasonBlock(league, season, lines)
  return block ? { game: null, season: block } : null
}

export function asCardLeague(v: unknown): CardLeague | null {
  return v === "mlb" ? "mlb" : asEspnLeague(v)
}

// ── Soccer cards (Panini) ────────────────────────────────────────────────────────────────────────
// A soccer card's back: the player's line in the competition and season its product is from
// (public.get_panini_card_soccer_line, ESPN's athlete stats). ESPN's soccer line has no appearances
// or minutes, only starts; a keeper has a second line (clean sheets, saves, goals against).

export interface SoccerCardLine {
  team_name?: string | null
  split_name?: string | null
  kind: "field" | "keeper"
  names: string[]
  values: string[]
}
export interface SoccerCardPayload {
  league_slug: string
  season_year: number
  lines: SoccerCardLine[]
}

const SOCCER_COMPETITION: Record<string, string> = { "fifa.world": "World Cup", "esp.1": "LALIGA", "ita.1": "Serie A", "fra.1": "Ligue 1" }

function sumLines(lines: SoccerCardLine[]): Map<string, number> {
  const out = new Map<string, number>()
  for (const l of lines) {
    if (!Array.isArray(l.names) || !Array.isArray(l.values) || l.names.length !== l.values.length) continue
    l.names.forEach((n, i) => {
      const v = num(l.values[i] ?? null)
      if (v != null) out.set(n, (out.get(n) ?? 0) + v)
    })
  }
  return out
}

export function soccerCardBlock(p: SoccerCardPayload | null | undefined): SlabStatBlock | null {
  if (!p || !Array.isArray(p.lines) || p.lines.length === 0) return null
  const comp = SOCCER_COMPETITION[p.league_slug]
  if (!comp || !Number.isInteger(p.season_year)) return null
  const title = p.league_slug === "fifa.world" ? `${p.season_year} World Cup` : `${p.season_year}-${String(p.season_year + 1).slice(-2)} ${comp}`
  const field = sumLines(p.lines.filter((l) => l.kind === "field"))
  const keeper = sumLines(p.lines.filter((l) => l.kind === "keeper"))
  const isKeeper = (keeper.get("SV") ?? 0) > 0 || (keeper.get("CS") ?? 0) > 0
  const chip = (m: Map<string, number>, name: string, label: string, keepZero: boolean): StatChip | null => {
    const v = m.get(name)
    if (v == null || (!keepZero && v === 0)) return null
    return { label, value: String(v) }
  }
  const chips = (isKeeper
    ? [chip(keeper, "CS", "CS", true), chip(keeper, "SV", "SV", true), chip(keeper, "GA", "GA", true), chip(field, "STRT", "GS", true)]
    : [chip(field, "G", "G", true), chip(field, "A", "A", true), chip(field, "STRT", "GS", true), chip(field, "SHOT", "SH", false), chip(field, "SOG", "SOT", false)]
  ).filter((c): c is StatChip => c != null)
  if (chips.length === 0 || chips.every((c) => isZeroLike(c.value))) return null
  const teams = Array.from(new Set(p.lines.map((l) => (l.team_name ?? "").trim()).filter(Boolean)))
  return { title, detail: teams.join(" / ") || null, chips }
}

// ── UFC Strike: the fight ────────────────────────────────────────────────────────────────────────
// public.get_ufc_moment_fight (ESPN's UFC scoreboard): the result from the Moment's fighter's side,
// the round it ended in and the clock. ESPN carries no method; the Moment's set name does ("UFC 303
// KO TKO"), and it describes the Moment — so it is shown only on a win, where the Moment is the finish.

export interface UfcFight {
  event_id?: string | null
  event_name?: string | null
  event_date?: string | null
  weight_class?: string | null
  rounds?: number | null
  end_period?: number | null
  end_clock?: string | null
  completed?: boolean | null
  winner?: boolean | null
  opponent_name?: string | null
  set_name?: string | null
}

function methodFromSet(setName: string | null | undefined): string | null {
  const s = String(setName ?? "").toUpperCase()
  if (/\bKO\b|\bTKO\b/.test(s)) return "KO/TKO"
  if (/\bSUBMISSION\b/.test(s)) return "SUB"
  return null
}

export function fightBlock(f: UfcFight | null | undefined): SlabStatBlock | null {
  if (!f || f.completed !== true || typeof f.winner !== "boolean" || !f.opponent_name) return null
  const chips: StatChip[] = [{ label: "Result", value: f.winner ? "W" : "L" }]
  const method = f.winner ? methodFromSet(f.set_name) : null
  if (method) chips.push({ label: "Method", value: method })
  if (Number.isInteger(f.end_period) && (f.end_period as number) > 0) chips.push({ label: "Round", value: `R${f.end_period}` })
  if (f.end_clock && /^\d{1,2}:\d{2}$/.test(f.end_clock)) chips.push({ label: "Time", value: f.end_clock })
  const event = (f.event_name ?? "").split(":")[0].trim() || null
  const detail = [`vs ${f.opponent_name}`, f.weight_class ?? null, event, plainDate(f.event_date)].filter(Boolean).join(" · ")
  const link = f.event_id && /^\d{4,12}$/.test(f.event_id) ? `https://www.espn.com/mma/fightcenter/_/id/${f.event_id}/league/ufc` : null
  return { title: "This fight", detail, chips, link, linkLabel: "ESPN fight card" }
}

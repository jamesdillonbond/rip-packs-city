import { describe, it, expect } from "vitest"
import { momentSeason, gameBlock, seasonBlock, slabStatsFromContext, plainDate, type SeasonLine } from "@/lib/slab-stats"
import { fetchSlabStats, isFunctionMissing } from "@/lib/moment-detail/slab-stats-fetch"

// Real ESPN shapes, captured 2026-11-25: Lillard's game log line for the NBA Cup game his
// Top Shot Moment comes from, and an NFL quarterback's playoff line.
const NBA_NAMES = ["minutes", "fieldGoalsMade-fieldGoalsAttempted", "fieldGoalPct", "threePointFieldGoalsMade-threePointFieldGoalsAttempted", "threePointPct", "freeThrowsMade-freeThrowsAttempted", "freeThrowPct", "totalRebounds", "assists", "blocks", "steals", "fouls", "turnovers", "points"]
const LILLARD = ["39", "8-15", "53.3", "2-5", "40.0", "10-10", "100.0", "2", "9", "0", "1", "4", "4", "28"]
const NFL_NAMES = ["completions", "passingAttempts", "passingYards", "completionPct", "yardsPerPassAttempt", "passingTouchdowns", "interceptions", "longPassing", "sacks", "QBRating", "adjQBR", "rushingAttempts", "rushingYards", "yardsPerRushAttempt", "rushingTouchdowns", "longRushing"]
const NFL_QB = ["21", "32", "257", "65.6", "8.0", "3", "2", "50", "6", "95.4", "10.0", "4", "25", "6.3", "0", "8"]
const AVG_NAMES = ["gamesPlayed", "gamesStarted", "avgMinutes", "avgFieldGoalsMade-avgFieldGoalsAttempted", "fieldGoalPct", "avgThreePointFieldGoalsMade-avgThreePointFieldGoalsAttempted", "threePointFieldGoalPct", "avgFreeThrowsMade-avgFreeThrowsAttempted", "freeThrowPct", "avgOffensiveRebounds", "avgDefensiveRebounds", "avgRebounds", "avgAssists", "avgBlocks", "avgSteals", "avgFouls", "avgTurnovers", "avgPoints"]
const LILLARD_AVG = ["58", "58", "36.1", "7.7-17.1", "44.8", "3.4-9.0", "37.6", "6.2-6.8", "92.1", "0.5", "4.2", "4.7", "7.1", "0.2", "1.2", "1.7", "2.8", "24.9"]
const avg = (values: string[], extra: Partial<SeasonLine> = {}): SeasonLine => ({ category: "averages", team_slug: "milwaukee-bucks", labels: AVG_NAMES, names: AVG_NAMES, values, ...extra })

describe("momentSeason (mirrors SQL moment_gamelog_season)", () => {
  it("numbers an NBA season by the year it ends", () => {
    expect(momentSeason("nba", "2024-12-11")).toBe(2025)
    expect(momentSeason("nba", "2025-04-20")).toBe(2025)
    expect(momentSeason("nba", "2025-10-22")).toBe(2026)
  })
  it("numbers an NFL season by the year it starts, Super Bowl included", () => {
    expect(momentSeason("nfl", "2024-09-08")).toBe(2024)
    expect(momentSeason("nfl", "2025-02-09")).toBe(2024)
  })
  it("numbers a WNBA season by the calendar year, and refuses a non-date", () => {
    expect(momentSeason("wnba", "2024-09-01")).toBe(2024)
    expect(momentSeason("nba", "not a date")).toBe(null)
  })
})

describe("gameBlock", () => {
  it("leads a basketball line with points, rebounds and assists, then shooting", () => {
    const b = gameBlock("nba", { source: "gamelog", game_date: "2024-12-10", at_vs: "vs", opponent_abbr: "ORL", score: "114-109", result: "W", season_type: "2024-25 Regular Season", names: NBA_NAMES, values: LILLARD })
    expect(b?.chips).toEqual([
      { label: "PTS", value: "28" },
      { label: "REB", value: "2" },
      { label: "AST", value: "9" },
      { label: "FG", value: "8-15" },
      { label: "3PT", value: "2-5" },
    ])
    expect(b?.detail).toBe("vs ORL · W 114-109 · Dec 10, 2024")
  })
  it("marks a playoff game and an away game", () => {
    const b = gameBlock("nba", { source: "gamelog", game_date: "2025-04-22", at_vs: "@", opponent_abbr: "IND", score: "115-123", result: "L", season_type: "2024-25 Postseason", names: NBA_NAMES, values: LILLARD })
    expect(b?.detail).toBe("@ IND · L 115-123 · Playoffs · Apr 22, 2025")
  })
  it("names NFL chips itself, because ESPN's labels repeat YDS", () => {
    const b = gameBlock("nfl", { source: "gamelog", game_date: "2025-02-09", at_vs: "vs", opponent_abbr: "PHI", score: "40-22", result: "L", season_type: "2024 Postseason", names: NFL_NAMES, values: NFL_QB })
    expect(b?.chips.map((c) => c.label)).toEqual(["C/ATT", "PASS YDS", "PASS TD", "INT", "RUSH YDS"])
    expect(b?.chips[0].value).toBe("21/32")
  })
  it("reads the box-score lane's keyed stats", () => {
    const b = gameBlock("nba", { source: "box", game_date: "2026-11-23", at_vs: "@", opponent_abbr: "PHI", did_not_play: false, stats: { points: "18", rebounds: "3", assists: "5", "fieldGoalsMade-fieldGoalsAttempted": "4-15" } })
    expect(b?.chips.slice(0, 3)).toEqual([{ label: "PTS", value: "18" }, { label: "REB", value: "3" }, { label: "AST", value: "5" }])
    expect(b?.detail).toBe("@ PHI · Nov 23, 2026")
  })
  it("shows nothing for a game the player did not play, or a line of zeros", () => {
    expect(gameBlock("nba", { source: "box", did_not_play: true, stats: { points: "0" } })).toBe(null)
    expect(gameBlock("nba", { source: "gamelog", names: NBA_NAMES, values: NBA_NAMES.map(() => "0") })).toBe(null)
    expect(gameBlock("nba", null)).toBe(null)
  })
  it("refuses a line whose names and values do not line up", () => {
    expect(gameBlock("nba", { source: "gamelog", names: NBA_NAMES, values: LILLARD.slice(1) })).toBe(null)
  })
})

describe("seasonBlock", () => {
  it("shows a basketball season's per-game averages with team and games played", () => {
    const b = seasonBlock("nba", 2025, [avg(LILLARD_AVG)])
    expect(b?.title).toBe("2024-25 season")
    expect(b?.detail).toBe("Milwaukee Bucks · 58 games")
    expect(b?.chips).toEqual([
      { label: "PPG", value: "24.9" },
      { label: "RPG", value: "4.7" },
      { label: "APG", value: "7.1" },
      { label: "FG%", value: "44.8" },
      { label: "3P%", value: "37.6" },
    ])
  })
  it("uses a traded season's total line and names both teams", () => {
    const b = seasonBlock("nba", 2024, [
      avg(LILLARD_AVG, { team_slug: "portland-trail-blazers" }),
      avg(LILLARD_AVG, { team_slug: "milwaukee-bucks" }),
      avg(LILLARD_AVG.map((v, i) => (i === 17 ? "26.0" : v)), { team_slug: null, is_total: true }),
    ])
    expect(b?.chips[0]).toEqual({ label: "PPG", value: "26.0" })
    expect(b?.detail).toContain("Portland Trail Blazers / Milwaukee Bucks")
  })
  it("leads an NFL season with the category the player was about", () => {
    const rows: SeasonLine[] = [
      { category: "passing", team_slug: "kansas-city-chiefs", labels: [], names: ["gamesPlayed", "passingAttempts", "passingYards", "passingTouchdowns", "interceptions", "QBRating"], values: ["16", "0", "0", "0", "0", "0"] },
      { category: "receiving", team_slug: "kansas-city-chiefs", labels: [], names: ["gamesPlayed", "receptions", "receivingYards", "receivingTouchdowns"], values: ["16", "97", "1338", "6"] },
    ]
    const b = seasonBlock("nfl", 2024, rows)
    expect(b?.title).toBe("2024 season")
    expect(b?.chips).toEqual([{ label: "REC", value: "97" }, { label: "REC YDS", value: "1338" }, { label: "REC TD", value: "6" }])
    expect(b?.detail).toBe("Kansas City Chiefs · 16 games")
  })
  it("shows nothing for no lines or an all-zero season", () => {
    expect(seasonBlock("nba", 2025, [])).toBe(null)
    expect(seasonBlock("nba", 2025, [avg(LILLARD_AVG.map(() => "0"))])).toBe(null)
  })
})

describe("slabStatsFromContext", () => {
  it("returns null when there is nothing real to show", () => {
    expect(slabStatsFromContext(null)).toBe(null)
    expect(slabStatsFromContext({ espn_league: "mlb", season: 2025, season_rows: [avg(LILLARD_AVG)], game: null })).toBe(null)
    expect(slabStatsFromContext({ espn_league: "nba", season: 2025, season_rows: [], game: null })).toBe(null)
  })
  it("carries the season alone when the game line has not arrived", () => {
    const s = slabStatsFromContext({ espn_league: "nba", season: 2025, season_rows: [avg(LILLARD_AVG)], game: null })
    expect(s?.game).toBe(null)
    expect(s?.season?.chips[0].value).toBe("24.9")
  })
  it("formats a calendar date without a clock zone", () => {
    expect(plainDate("2024-12-10")).toBe("Dec 10, 2024")
    expect(plainDate(null)).toBe(null)
  })
})

// ── the fetcher: the staged reader first, the season-stats fallback until it exists ──
type Call = { fn: string; args: Record<string, unknown> }
function fakeClient(answers: {
  ctx?: { data: unknown; error: { code?: string; message?: string } | null }
  playerId?: { data: unknown; error: { message?: string } | null }
  season?: { data: unknown; error: { message?: string } | null }
}) {
  const calls: Call[] = []
  return {
    calls,
    rpc(fn: string, args: Record<string, unknown>) {
      calls.push({ fn, args })
      if (fn === "get_moment_game_context") return Promise.resolve(answers.ctx ?? { data: null, error: null })
      return Promise.resolve(answers.season ?? { data: null, error: null })
    },
    from() {
      return { select: () => ({ eq: () => ({ limit: () => ({ maybeSingle: () => Promise.resolve(answers.playerId ?? { data: null, error: null }) }) }) }) }
    },
  }
}
const ED = { id: "1550ddee-6066-476d-bd61-0348d568347e", collection_slug: "nba_top_shot", game_date: "2024-12-11" }
const MISSING = { code: "PGRST202", message: "Could not find the function public.get_moment_game_context(p_edition_id) in the schema cache" }

describe("fetchSlabStats", () => {
  it("reads nothing for a collection without ESPN stats or a Moment with no game date", async () => {
    const c = fakeClient({})
    expect(await fetchSlabStats({ ...ED, collection_slug: "disney_pinnacle" }, c as never)).toEqual({ ok: true, ctx: null })
    expect(await fetchSlabStats({ ...ED, game_date: null }, c as never)).toEqual({ ok: true, ctx: null })
    expect(c.calls).toHaveLength(0)
  })
  it("returns the game context when the reader exists", async () => {
    const ctx = { espn_league: "nba", season: 2025, season_rows: [], game: null }
    const c = fakeClient({ ctx: { data: ctx, error: null } })
    expect(await fetchSlabStats(ED, c as never)).toEqual({ ok: true, ctx })
    expect(c.calls.map((x) => x.fn)).toEqual(["get_moment_game_context"])
  })
  it("falls back to that season's lines while the reader is not in the database", async () => {
    const c = fakeClient({
      ctx: { data: null, error: MISSING },
      playerId: { data: { player_id: "1fad8fd1-188a-4ee9-9070-a8037434803a" }, error: null },
      season: { data: { league: "nba", espn_league: "nba", rows: [{ ...avg(LILLARD_AVG), season: 2025, season_type: 2 }, { ...avg(LILLARD_AVG), season: 2024, season_type: 2 }] }, error: null },
    })
    const r = await fetchSlabStats(ED, c as never)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.ctx?.season).toBe(2025)
      expect(r.ctx?.season_rows).toHaveLength(1)
      expect(r.ctx?.game).toBe(null)
    }
    expect(c.calls.map((x) => x.fn)).toEqual(["get_moment_game_context", "get_player_season_stats"])
    expect(c.calls[1].args).toEqual({ p_player_id: "1fad8fd1-188a-4ee9-9070-a8037434803a", p_seasons: 20 })
  })
  it("reports a failed read as a failure, never as 'no stats'", async () => {
    expect((await fetchSlabStats(ED, fakeClient({ ctx: { data: null, error: { code: "57014", message: "canceling statement" } } }) as never)).ok).toBe(false)
    expect((await fetchSlabStats(ED, fakeClient({ ctx: { data: null, error: MISSING }, playerId: { data: null, error: { message: "boom" } } }) as never)).ok).toBe(false)
    expect((await fetchSlabStats(ED, fakeClient({ ctx: { data: null, error: MISSING }, playerId: { data: { player_id: "x" }, error: null }, season: { data: null, error: { message: "boom" } } }) as never)).ok).toBe(false)
  })
  it("is ok-and-empty for a Moment with no player or no ESPN identity", async () => {
    expect(await fetchSlabStats(ED, fakeClient({ ctx: { data: null, error: MISSING }, playerId: { data: { player_id: null }, error: null } }) as never)).toEqual({ ok: true, ctx: null })
    expect(await fetchSlabStats(ED, fakeClient({ ctx: { data: null, error: MISSING }, playerId: { data: { player_id: "x" }, error: null }, season: { data: null, error: null } }) as never)).toEqual({ ok: true, ctx: null })
  })
  it("recognises PostgREST's missing-function answer by code or by message", () => {
    expect(isFunctionMissing({ code: "PGRST202" })).toBe(true)
    expect(isFunctionMissing({ message: "Could not find the function public.x" })).toBe(true)
    expect(isFunctionMissing({ code: "57014", message: "canceling statement" })).toBe(false)
    expect(isFunctionMissing(null)).toBe(false)
  })
})

describe("fetchSlabStats budget", () => {
  it("treats a read that overruns its budget as a failed read", async () => {
    const hang = {
      rpc: () => new Promise(() => {}),
      from: () => ({ select: () => ({ eq: () => ({ limit: () => ({ maybeSingle: () => new Promise(() => {}) }) }) }) }),
    }
    const r = await fetchSlabStats(ED, hang as never, 20)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/slab stats.*exceeded 20ms/)
  })
})

describe("above-average markers and the ESPN link", () => {
  it("marks basketball game stats that beat the season's per-game average", () => {
    const s = slabStatsFromContext({
      espn_league: "nba", season: 2025, season_rows: [avg(LILLARD_AVG)],
      game: { source: "gamelog", event_id: "401734902", game_date: "2024-12-10", at_vs: "vs", opponent_abbr: "ORL", score: "114-109", result: "W", names: NBA_NAMES, values: LILLARD },
    })
    const marks = Object.fromEntries((s?.game?.chips ?? []).map((c) => [c.label, !!c.aboveAverage]))
    // 28 PTS > 24.9 PPG, 2 REB < 4.7 RPG, 9 AST > 7.1 APG; shooting lines are never marked
    expect(marks).toEqual({ PTS: true, REB: false, AST: true, FG: false, "3PT": false })
    expect(s?.game?.link).toBe("https://www.espn.com/nba/game/_/gameId/401734902")
  })
  it("marks nothing without a season line, and never on NFL", () => {
    const g = slabStatsFromContext({ espn_league: "nba", season: 2025, season_rows: [], game: { source: "gamelog", names: NBA_NAMES, values: LILLARD } })
    expect(g?.game?.chips.some((c) => c.aboveAverage)).toBe(false)
    const n = slabStatsFromContext({ espn_league: "nfl", season: 2024, season_rows: [], game: { source: "gamelog", names: NFL_NAMES, values: NFL_QB } })
    expect(n?.game?.chips.some((c) => c.aboveAverage)).toBe(false)
  })
  it("links only an ESPN numeric event id", async () => {
    const { espnGameUrl } = await import("@/lib/slab-stats")
    expect(espnGameUrl("wnba", "401620123")).toBe("https://www.espn.com/wnba/game/_/gameId/401620123")
    expect(espnGameUrl("nba", "abc")).toBe(null)
    expect(espnGameUrl("nba", null)).toBe(null)
  })
})

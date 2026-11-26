// 2026-11-26 (Trevor: "Yes do it all"): Panini and Candy cards get a season line on the slab's back.
// A card has no game, so the line is the season the CARD is from — never another season.
import { describe, it, expect } from "vitest"
import { cardSeason, cardSlabStats, seasonBlock, soccerCardBlock, type SeasonLine } from "@/lib/slab-stats"
import { fetchCardSlabStats } from "@/lib/moment-detail/slab-stats-fetch"

const BAT_NAMES = ["gamesPlayed", "atBats", "runs", "hits", "doubles", "triples", "homeRuns", "RBIs", "walks", "hitByPitch", "strikeouts", "stolenBases", "caughtStealing", "avg", "onBasePct", "slugAvg", "OPS", "WARBR"]
const PIT_NAMES = ["gamesPlayed", "gamesStarted", "wins", "losses", "winPct", "WARBR", "ERA", "WHIP", "innings", "strikeouts", "walks", "strikeoutToWalkRatio", "hits", "runs", "earnedRuns", "saves", "holds", "blownSaves"]
type Row = SeasonLine & { season: number; season_type?: number }
const bat = (season: number, values: string[], team = "chicago-cubs"): Row =>
  ({ season, season_type: 2, category: "career-batting", is_total: false, team_slug: team, names: BAT_NAMES, values }) as unknown as Row
const pit = (season: number, values: string[], team = "atlanta-braves"): Row =>
  ({ season, season_type: 2, category: "pitching", is_total: false, team_slug: team, names: PIT_NAMES, values }) as unknown as Row
// Bregman 2026, measured from player_season_stats 2026-11-26.
const BREGMAN_2026 = ["155", "608", "92", "161", "33", "2", "28", "93", "76", "12", "102", "3", "1", ".265", ".355", ".464", ".819", "5.8"]
const SALE_2026 = ["27", "27", "14", "9", ".609", "5.5", "2.16", "0.98", "162.2", "200", "31", "6.5", "129", "44", "39", "0", "0", "0"]

describe("cardSeason", () => {
  it("reads the season a card is from", () => {
    expect(cardSeason("nba", "BC 2021-22 Donruss Net Marvels")).toBe(2022)
    expect(cardSeason("nba", "1999-00 Legends")).toBe(2000)
    expect(cardSeason("nfl", "2021 Prizm")).toBe(2021)
    expect(cardSeason("nfl", "2021-22 Something")).toBe(2021)
    expect(cardSeason("mlb", "2022 Leadoff ICONs")).toBe(2022)
    expect(cardSeason("wnba", "2023 Prizm WNBA")).toBe(2023)
  })
  it("never guesses", () => {
    expect(cardSeason("nba", "2024 Prizm")).toBe(null) // could be 2023-24 or 2024-25
    expect(cardSeason("nba", "Donruss Net Marvels")).toBe(null)
    expect(cardSeason("nba", "2021-23 Odd")).toBe(null)
    expect(cardSeason("mlb", "2021-22 Something")).toBe(null)
    expect(cardSeason("mlb", null)).toBe(null)
    expect(cardSeason("nba", "2020-21 NFT NBA Entertainment - BC 2021-22 Prizm 75 Years of NBA Challenge")).toBe(null)
    expect(cardSeason("nba", "BC 2021-22 Prizm 2021-22")).toBe(2022)
  })
})

describe("MLB season block", () => {
  it("a hitter's line", () => {
    const b = seasonBlock("mlb", 2026, [bat(2026, BREGMAN_2026)])
    expect(b?.title).toBe("2026 season")
    expect(b?.chips.map((c) => `${c.label} ${c.value}`)).toEqual(["AVG .265", "HR 28", "RBI 93", "OPS .819", "SB 3"])
    expect(b?.detail).toBe("Chicago Cubs · 155 games")
  })
  it("a pitcher's line leads when his batting is a handful of at-bats", () => {
    const few = ["3", "4", "0", "1", "0", "0", "0", "0", "0", "0", "2", "0", "0", ".250", ".250", ".250", ".500", "0.0"]
    const b = seasonBlock("mlb", 2026, [bat(2026, few, "atlanta-braves"), pit(2026, SALE_2026)])
    expect(b?.chips.map((c) => c.label)).toEqual(["W", "ERA", "K", "WHIP"])
    expect(b?.chips.find((c) => c.label === "ERA")?.value).toBe("2.16")
  })
})

describe("cardSlabStats", () => {
  it("shows the card's own season and nothing else", () => {
    const rows = [bat(2026, BREGMAN_2026), bat(2025, BREGMAN_2026, "boston-red-sox")]
    expect(cardSlabStats("mlb", "2025 All-Star ICONS", rows)?.season?.title).toBe("2025 season")
    expect(cardSlabStats("mlb", "2025 All-Star ICONS", rows)?.game).toBe(null)
    // a legend's card: the player has no line that season → nothing, never a namesake's latest season
    expect(cardSlabStats("mlb", "1998 Legends", rows)).toBe(null)
    expect(cardSlabStats(null, "2025 All-Star ICONS", rows)).toBe(null)
  })
})

function client(answers: { rpc?: { data: unknown; error: { message?: string } | null }; soccer?: { data: unknown; error: { code?: string; message?: string } | null }; ed?: { data: unknown; error: { message?: string } | null }; prod?: { data: unknown; error: { message?: string } | null } }) {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = []
  return {
    calls,
    rpc(fn: string, args: Record<string, unknown>) {
      calls.push({ fn, args })
      if (fn === "get_panini_card_soccer_line") return Promise.resolve(answers.soccer ?? { data: null, error: null })
      return Promise.resolve(answers.rpc ?? { data: null, error: null })
    },
    from(table: string) {
      const a = table === "panini_products" ? answers.prod : answers.ed
      return { select: () => ({ eq: () => ({ limit: () => ({ maybeSingle: () => Promise.resolve(a ?? { data: null, error: null }) }) }) }) }
    },
  }
}

describe("fetchCardSlabStats", () => {
  const CARD = { id: "e1", collection_slug: "panini_blockchain", set_name: "2026 Prizm Baseball", player_names: ["Alex Bregman", null] }
  it("Panini reads the crosswalk by the player's slug", async () => {
    const c = client({ rpc: { data: { league: "mlb", espn_league: "mlb", rows: [bat(2026, BREGMAN_2026)] }, error: null } })
    const r = await fetchCardSlabStats(CARD, c as never)
    expect(c.calls).toEqual([{ fn: "get_panini_player_season_stats", args: { p_slugs: ["alex-bregman"], p_seasons: 20 } }]) // no product id → no soccer read
    expect(r.ok && r.stats?.season?.title).toBe("2026 season")
  })
  it("Candy reads by the edition's player", async () => {
    const c = client({ ed: { data: { player_id: "p1" }, error: null }, rpc: { data: { league: "mlb", rows: [bat(2026, BREGMAN_2026)] }, error: null } })
    const r = await fetchCardSlabStats({ ...CARD, collection_slug: "candy_mlb" }, c as never)
    expect(c.calls).toEqual([{ fn: "get_player_season_stats", args: { p_player_id: "p1", p_seasons: 20 } }])
    expect(r.ok && r.stats != null).toBe(true)
  })
  it("Panini takes the season from the card's PRODUCT, not its set", async () => {
    const avg = { season: 2022, season_type: 2, category: "averages", is_total: false, team_slug: "boston-celtics", names: ["gamesPlayed", "avgPoints", "avgRebounds", "avgAssists"], values: ["76", "26.9", "8.0", "4.4"] }
    const c = client({
      rpc: { data: { league: "nba", espn_league: "nba", rows: [avg] }, error: null },
      prod: { data: { name: "2021-22 Panini NFT Noir Basketball" }, error: null },
    })
    const r = await fetchCardSlabStats({ id: "e2", collection_slug: "panini_blockchain", set_name: "Base Prizms Silver", external_id: "packcard-1618_1_2_3", player_names: ["Jayson Tatum"] }, c as never)
    expect(r.ok && r.stats?.season?.title).toBe("2021-22 season")
    // the card's own set name wins when it names a season (Tatum's Net Marvels sits in a "2021 …" NBA product)
    const t = client({
      rpc: { data: { league: "nba", espn_league: "nba", rows: [avg] }, error: null },
      prod: { data: { name: "2021 Panini Blockchain NBA Packs Prizm Entertainment" }, error: null },
    })
    const tr = await fetchCardSlabStats({ id: "e3", collection_slug: "panini_blockchain", set_name: "BC 2021-22 Donruss Net Marvels", external_id: "packcard-1587_290609_7625797_19", player_names: ["Jayson Tatum"] }, t as never)
    expect(tr.ok && tr.stats?.season?.title).toBe("2021-22 season")
    // a failed product read is a failed read
    const d = client({ rpc: { data: { league: "nba", rows: [avg] }, error: null }, prod: { data: null, error: { message: "boom" } } })
    expect((await fetchCardSlabStats({ id: "e2", collection_slug: "panini_blockchain", set_name: "Base", external_id: "packcard-1618_1", player_names: ["Jayson Tatum"] }, d as never)).ok).toBe(false)
  })
  it("other collections read nothing", async () => {
    const c = client({})
    expect(await fetchCardSlabStats({ ...CARD, collection_slug: "nba_top_shot" }, c as never)).toEqual({ ok: true, stats: null })
    expect(c.calls).toHaveLength(0)
  })
  it("a failed read is a failure, never 'no stats'", async () => {
    expect((await fetchCardSlabStats(CARD, client({ rpc: { data: null, error: { message: "boom" } } }) as never)).ok).toBe(false)
    expect((await fetchCardSlabStats({ ...CARD, collection_slug: "candy_mlb" }, client({ ed: { data: null, error: { message: "boom" } } }) as never)).ok).toBe(false)
  })
  it("a WNBA player's season is a calendar year", async () => {
    const avg = { season: 2023, season_type: 2, category: "averages", is_total: false, team_slug: "las-vegas-aces", names: ["gamesPlayed", "avgPoints", "avgRebounds", "avgAssists"], values: ["40", "22.8", "9.5", "2.3"] }
    const c = client({ rpc: { data: { league: "nba", espn_league: "wnba", rows: [avg] }, error: null } })
    const r = await fetchCardSlabStats({ ...CARD, set_name: "2023 Prizm WNBA", player_names: ["A'ja Wilson"] }, c as never)
    expect(r.ok && r.stats?.season?.title).toBe("2023 season")
  })
})

const WC = (vals: string[], team = "Argentina") => ({ team_name: team, split_name: "2022 FIFA World Cup", kind: "field" as const, names: ["STRT", "FC", "FA", "YC", "RC", "G", "A", "SHOT", "SOG", "OFF"], values: vals })

describe("soccer card backs", () => {
  it("a scorer's World Cup", () => {
    // Messi, 2022 FIFA World Cup — measured from ESPN 2026-11-26 (7 G, 3 A)
    const b = soccerCardBlock({ league_slug: "fifa.world", season_year: 2022, lines: [WC(["7", "9", "22", "1", "0", "7", "3", "31", "17", "4"])] })
    expect(b?.title).toBe("2022 World Cup")
    expect(b?.detail).toBe("Argentina")
    expect(b?.chips.map((c) => `${c.label} ${c.value}`)).toEqual(["G 7", "A 3", "GS 7", "SH 31", "SOT 17"])
  })
  it("a keeper's club season, summed across two clubs", () => {
    const keeper = (t: string, v: string[]) => ({ team_name: t, kind: "keeper" as const, names: ["CS", "SV", "GA"], values: v })
    const b = soccerCardBlock({
      league_slug: "esp.1", season_year: 2022,
      lines: [{ ...WC(["31", "0", "3", "0", "0", "0", "0", "0", "0", "3"], "Real Madrid") }, keeper("Real Madrid", ["10", "79", "29"])],
    })
    expect(b?.title).toBe("2022-23 LALIGA")
    expect(b?.chips.map((c) => `${c.label} ${c.value}`)).toEqual(["CS 10", "SV 79", "GA 29", "GS 31"])
  })
  it("no line, an unknown competition, or all zeros → nothing", () => {
    expect(soccerCardBlock({ league_slug: "fifa.world", season_year: 2022, lines: [] })).toBe(null)
    expect(soccerCardBlock({ league_slug: "usa.1", season_year: 2022, lines: [WC(["7", "0", "0", "0", "0", "7", "3", "0", "0", "0"])] })).toBe(null)
    expect(soccerCardBlock({ league_slug: "fifa.world", season_year: 2022, lines: [WC(["0", "0", "0", "0", "0", "0", "0", "0", "0", "0"])] })).toBe(null)
    expect(soccerCardBlock(null)).toBe(null)
  })
  it("the Panini read uses the soccer line when there is one, and tolerates a missing reader", async () => {
    const card = { id: "e9", collection_slug: "panini_blockchain", set_name: "Base", external_id: "packcard-2001_1_1_1", player_names: ["Lionel Messi"] }
    const c = client({ soccer: { data: { league_slug: "fifa.world", season_year: 2022, lines: [WC(["7", "9", "22", "1", "0", "7", "3", "31", "17", "4"])] }, error: null } })
    const r = await fetchCardSlabStats(card, c as never)
    expect(r.ok && r.stats?.season?.title).toBe("2022 World Cup")
    expect(c.calls.find((x) => x.fn === "get_panini_card_soccer_line")?.args).toEqual({ p_slugs: ["lionel-messi"], p_external_id: "packcard-2001_1_1_1" })
    const missing = client({ soccer: { data: null, error: { code: "PGRST202", message: "Could not find the function" } } })
    expect((await fetchCardSlabStats(card, missing as never)).ok).toBe(true)
    const failed = client({ soccer: { data: null, error: { code: "57014", message: "canceling statement" } } })
    expect((await fetchCardSlabStats(card, failed as never)).ok).toBe(false)
  })
})

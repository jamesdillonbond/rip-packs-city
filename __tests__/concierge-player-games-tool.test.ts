import { describe, it, expect, beforeEach } from "vitest"
import { readFileSync } from "node:fs"
import {
  runPlayerGamesTool,
  marketCapKey,
  marketMove,
  statLine,
  type PlayerGamesToolDeps,
} from "@/lib/concierge/player-games-tool"

// The concierge's get_player_games tool (2026-11-08). Pins: Top Shot / All Day / Candy are read
// by the RESOLVED PERSON (the All Day slug "josh-allen" carries two ESPN ids — the QB and an
// unlinked namesake — and only the person key separates them); Golazos / Panini by the market-cap
// slug; Pinnacle / UFC refused without a read; and the four honest states (error, not_linked,
// ambiguous, no_games) never collapse into "did not play" or a fabricated line.

const calls: Array<{ fn: string; args: any }> = []
let rpcData: any = null
let rpcError: any = null
const supabase = {
  rpc: async (fn: string, args: any) => {
    calls.push({ fn, args })
    return rpcError ? { data: null, error: rpcError } : { data: rpcData, error: null }
  },
}

const deps = (over: Partial<PlayerGamesToolDeps> = {}): PlayerGamesToolDeps => ({
  supabase,
  resolvePerson: async (_uuid, name) =>
    name === "Marvin Harrison"
      ? { status: "stop", payload: { status: "ambiguous", player: name } }
      : name === "Marvin Harrison Jr."
        ? { status: "ok", playerId: "p-mhj", slug: "marvin-harrison-jr-", label: "Marvin Harrison Jr." }
        : { status: "ok", playerId: "p-luka", slug: "luka-doncic", label: "Luka Dončić" },
  ...over,
})

const LUKA_GAME = {
  date: "2026-11-06", league: "nba", opponent: "POR", is_home: true, did_not_play: false, minutes: 38,
  fantasy_points: 69.75,
  stats: { line: { points: "53", rebounds: "5", assists: "5", steals: "1", blocks: "0", minutes: "38" } },
  mcap_before: 1155175.21, mcap_after: 1211758.47, held_before: 220792, held_after: 220796,
}

beforeEach(() => {
  calls.length = 0
  rpcError = null
  rpcData = { linked: 1, espn_ids: ["3945274"], games: [LUKA_GAME], season_avg_fp: 71.55, games_in_season: 5, first_game_date: "2026-10-30", mcap_now: 1211868.16 }
})

describe("get_player_games — what it reads", () => {
  it("reads Top Shot by the resolved PERSON, with the page slug and the market-cap key", async () => {
    await runPlayerGamesTool({ name: "luka" }, "nba-top-shot", deps())
    expect(calls).toHaveLength(1)
    expect(calls[0].fn).toBe("get_player_recent_games")
    expect(calls[0].args.p_collection_slug).toBe("nba_top_shot")
    expect(calls[0].args.p_player_id).toBe("p-luka")
    expect(calls[0].args.p_slugs).toEqual(expect.arrayContaining(["luka-doncic", "luka"]))
  })

  it("passes NO person id for Golazos and Panini (their crosswalks are slug-keyed)", async () => {
    await runPlayerGamesTool({ name: "luka", collectionId: "panini-blockchain" }, "nba-top-shot", deps())
    expect(calls[0].args.p_collection_slug).toBe("panini_blockchain")
    expect(calls[0].args.p_player_id).toBeNull()
  })

  it("adds the market-cap key without the trailing dash a 'Jr.' page slug keeps", async () => {
    await runPlayerGamesTool({ name: "Marvin Harrison Jr.", collectionId: "nfl-all-day" }, "nba-top-shot", deps())
    expect(calls[0].args.p_slugs).toEqual(expect.arrayContaining(["marvin-harrison-jr-", "marvin-harrison-jr"]))
    expect(marketCapKey("Luka Dončić")).toBe("luka-doncic")
  })

  it("clamps the limit to 1..15", async () => {
    await runPlayerGamesTool({ name: "luka", limit: 99 }, "nba-top-shot", deps())
    expect(calls[0].args.p_limit).toBe(15)
  })
})

describe("get_player_games — refusals read nothing", () => {
  it("refuses Pinnacle and UFC without a read", async () => {
    for (const c of ["disney-pinnacle", "ufc"]) {
      const out = await runPlayerGamesTool({ name: "x", collectionId: c }, "nba-top-shot", deps())
      expect(out.status).toBe("not_applicable")
    }
    expect(calls).toHaveLength(0)
  })

  it("refuses an unknown collection instead of answering with another one's player", async () => {
    const out = await runPlayerGamesTool({ name: "luka", collectionId: "nope" }, "nba-top-shot", deps())
    expect(out.status).toBe("error")
    expect(calls).toHaveLength(0)
  })

  it("stops on an ambiguous person and reads nothing", async () => {
    const out = await runPlayerGamesTool({ name: "Marvin Harrison", collectionId: "nfl-all-day" }, "nba-top-shot", deps())
    expect(out.status).toBe("ambiguous")
    expect(calls).toHaveLength(0)
  })

  it("requires a name", async () => {
    expect((await runPlayerGamesTool({}, "nba-top-shot", deps())).status).toBe("error")
  })
})

describe("get_player_games — four honest states", () => {
  it("a failed read is an error that forbids the no-games conclusion", async () => {
    rpcError = { message: "timeout" }
    const out = await runPlayerGamesTool({ name: "luka" }, "nba-top-shot", deps())
    expect(out.status).toBe("error")
    expect(out.games).toBeUndefined()
    expect(String(out.message)).toMatch(/never that the player has no games/)
  })

  it("no linked feed is not_linked — never 'did not play'", async () => {
    rpcData = { linked: 0, espn_ids: [], games: [], season_avg_fp: null, games_in_season: 0, first_game_date: null, mcap_now: 100 }
    const out = await runPlayerGamesTool({ name: "luka" }, "nba-top-shot", deps())
    expect(out.status).toBe("not_linked")
    expect(out.games).toBeUndefined()
  })

  it("two ESPN athletes behind one key is ambiguous, with no games merged", async () => {
    rpcData = { linked: 2, espn_ids: ["1", "2"], games: [], season_avg_fp: null, games_in_season: 0, first_game_date: null, mcap_now: null }
    const out = await runPlayerGamesTool({ name: "luka" }, "nba-top-shot", deps())
    expect(out.status).toBe("ambiguous")
    expect(out.games).toBeUndefined()
  })

  it("linked with no games says no_games, not an empty ok", async () => {
    rpcData = { linked: 1, espn_ids: ["1"], games: [], season_avg_fp: null, games_in_season: 0, first_game_date: null, mcap_now: 5 }
    const out = await runPlayerGamesTool({ name: "luka" }, "nba-top-shot", deps())
    expect(out.status).toBe("no_games")
  })

  it("ok: the stat line, the gap to the season average, and the market move", async () => {
    const out: any = await runPlayerGamesTool({ name: "luka" }, "nba-top-shot", deps())
    expect(out.status).toBe("ok")
    const g = out.games[0]
    expect(g.line).toBe("53 pts, 5 reb, 5 ast, 1 stl, 38 min")
    expect(g.vs_season_average).toBe(-1.8)
    expect(g.market.change_pct).toBe(4.9)
    expect(g.market.collector_held_change).toBe(4)
    // +4 of 220,792 held is noise beside a +4.9 % move: the note must say PRICE, not supply
    // (live 11-08 the old note read "+17 … part of this move is supply" beside −11.9 %).
    expect(g.market.note).toMatch(/barely changed/)
    expect(g.market.note).toMatch(/this move is price, not supply/)
    expect(g.market.note).not.toMatch(/real part of this move is supply/)
    expect(out.method).toMatch(/single game is not evidence/)
  })
})

describe("get_player_games — pure helpers", () => {
  it("names supply as a driver only when it is a real share of the move", () => {
    const real = marketMove({ mcap_before: 100, mcap_after: 112, held_before: 100, held_after: 110 })
    expect(real.note).toMatch(/real part of this move is supply/)
    const tiny = marketMove({ mcap_before: 1311240, mcap_after: 1155175, held_before: 220775, held_after: 220792 })
    expect(tiny.change_pct).toBe(-11.9)
    expect(tiny.note).toMatch(/barely changed \(\+17 of 220,775 held, <0\.01%\)/)
  })

  it("no supply note when collector-held is unchanged; no % when a side is missing", () => {
    expect(marketMove({ mcap_before: 100, mcap_after: 110, held_before: 5, held_after: 5 }).note).toBeUndefined()
    const missing = marketMove({ mcap_before: null, mcap_after: 110, held_before: null, held_after: 5 })
    expect(missing.change_pct).toBeNull()
  })

  it("renders NFL and soccer lines by box group, and nothing for an unscored MLB line", () => {
    expect(statLine("nfl", { passing: { "completions/passingAttempts": "24/34", passingYards: "247", passingTouchdowns: "1", interceptions: "0" } }))
      .toBe("24/34 passing, 247 yds, 1 TD, 0 INT")
    expect(statLine("laliga", { line: { totalGoals: "1", goalAssists: "0", shotsOnTarget: "2", yellowCards: "1" } }))
      .toBe("1 goals, 0 assists, 2 on target, 1 yellow")
    expect(statLine("mlb", { batting: { hits: "2" } })).toBeNull()
  })
})

describe("get_player_games — wired into the concierge", () => {
  const SRC = readFileSync("app/api/support-chat/route.ts", "utf8")
  it("declares the tool, routes it, budgets it and names it in the prompt", () => {
    expect(SRC).toMatch(/name: "get_player_games"/)
    expect(SRC).toMatch(/if \(toolName === "get_player_games"\)/)
    expect(SRC).toMatch(/get_player_games: \d+/)
    expect(SRC).toMatch(/\(get_player_games\)/)
  })
  it("hands the RESOLVED person id to the tool, not a name", () => {
    const branch = SRC.slice(SRC.indexOf('if (toolName === "get_player_games")'))
    expect(branch.slice(0, 1500)).toMatch(/playerId: resolution\.player\.id/)
  })
})
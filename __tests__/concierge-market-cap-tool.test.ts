import { describe, it, expect, beforeEach } from "vitest"
import { runMarketCapTool, type MarketCapToolDeps } from "@/lib/concierge/market-cap-tool"

// The concierge's get_market_cap tool. Pins: the exact RPC each question reaches
// (so the bot and the site read the same rows), names resolved to the PERSON /
// FRANCHISE before matching, an ambiguous name stopping the read, an unknown cap
// staying null (never $0), and refusals for unknown collections / grains.

const calls: Array<{ fn: string; args: any }> = []
let entityRows: any[] = []
let boardRows: any[] = []
let rpcError: any = null

const supabase = {
  rpc: async (fn: string, args: any) => {
    calls.push({ fn, args })
    if (rpcError) return { data: null, error: rpcError }
    return { data: fn === "get_market_cap_entity" ? entityRows : boardRows, error: null }
  },
}

const resolverCalls: string[] = []
const deps = (over: Partial<MarketCapToolDeps> = {}): MarketCapToolDeps => ({
  supabase,
  siteBase: "https://rpc.test",
  resolvePlayerSlug: async (_uuid, name) => {
    resolverCalls.push(`player:${name}`)
    return name === "Marvin Harrison"
      ? { status: "stop", payload: { status: "ambiguous", player: name } }
      : { status: "ok", slug: "lebron-james", label: "LeBron James" }
  },
  resolveTeamSlug: async (_uuid, name) => {
    resolverCalls.push(`team:${name}`)
    return { status: "ok", slug: "los-angeles-lakers", label: "Los Angeles Lakers" }
  },
  ...over,
})

const ENTITY = {
  collection_slug: "nba_top_shot", group_label: "LeBron James", editions: 138, editions_supply_known: 134, editions_priced: 131,
  minted: 310049, burned: 22637, issuer_held: 13442, collector_held: 273774,
  mcap_usd: 4495214.02, mcap_high_conf_usd: 2231644.72, mcap_minted_usd: 5083355.49,
  mcap_rank: 1, groups_ranked: 1362, mcap_usd_7d_ago: null, refreshed_at: "2026-10-03T22:41:00Z",
}
const BOARD_ROW = (over: any) => ({
  collection_slug: "nba_top_shot", group_key: "nba_top_shot", group_label: "nba_top_shot", set_name: null, tier: null,
  series_num: null, series_name: null, edition_external_id: null, editions: 10, editions_supply_known: 10, editions_priced: 10,
  minted: 100, burned: 10, issuer_held: 5, collector_held: 85, mcap_usd: 850, mcap_high_conf_usd: 425, mcap_minted_usd: 1000,
  mcap_usd_7d_ago: null, ...over,
})

beforeEach(() => {
  calls.length = 0
  resolverCalls.length = 0
  entityRows = []
  boardRows = []
  rpcError = null
})

describe("get_market_cap", () => {
  it("no name → the collection leaderboard over EVERY collection", async () => {
    boardRows = [BOARD_ROW({}), BOARD_ROW({ collection_slug: "ufc_strike", group_key: "ufc_strike", mcap_usd: null, mcap_high_conf_usd: null, collector_held: null, mcap_minted_usd: 4862354.3 })]
    const out: any = await runMarketCapTool({}, "nfl-all-day", deps())
    expect(calls).toEqual([{ fn: "get_market_cap_board", args: { p_group: "collection", p_collection: null, p_limit: 50 } }])
    expect(out.kind).toBe("leaderboard")
    const ufc = out.rows.find((r: any) => r.collection === "ufc_strike")
    expect(ufc.market_cap_usd).toBeNull()
    expect(ufc.market_cap_status).toMatch(/unknown/)
    expect(ufc.minted_supply_upper_bound_usd).toBe(4862354.3)
  })

  it("a player name is resolved to the PERSON, then read by that page's slug", async () => {
    entityRows = [ENTITY]
    const out: any = await runMarketCapTool({ grain: "player", name: "lebron" }, "nba-top-shot", deps())
    expect(resolverCalls).toEqual(["player:lebron"])
    expect(calls).toEqual([{ fn: "get_market_cap_entity", args: { p_group: "player", p_collection: "nba_top_shot", p_match: "lebron-james" } }])
    expect(out).toMatchObject({ status: "ok", name: "LeBron James", market_cap_usd: 4495214.02, rank: 1, ranked_out_of_with_known_cap: 1362, high_confidence_share: 0.496 })
    expect(out.change_7d).toBeNull()
    expect(out.change_7d_note).toMatch(/Oct 3, 2026/)
  })

  it("an AMBIGUOUS name stops before any market-cap read", async () => {
    const out: any = await runMarketCapTool({ grain: "player", name: "Marvin Harrison" }, "nfl-all-day", deps())
    expect(out.status).toBe("ambiguous")
    expect(calls).toHaveLength(0)
  })

  it("a team goes through the franchise resolver", async () => {
    entityRows = [{ ...ENTITY, group_label: "Los Angeles Lakers" }]
    await runMarketCapTool({ grain: "team", name: "Lakers" }, "nba-top-shot", deps())
    expect(resolverCalls).toEqual(["team:Lakers"])
    expect(calls[0].args.p_match).toBe("los-angeles-lakers")
  })

  it("Pinnacle franchises and characters skip the sports resolvers and use the page slug (™ stripped)", async () => {
    entityRows = [{ ...ENTITY, collection_slug: "disney_pinnacle" }]
    await runMarketCapTool({ grain: "team", name: "Star Wars™" }, "disney-pinnacle", deps())
    await runMarketCapTool({ grain: "player", name: "Minnie Mouse" }, "disney-pinnacle", deps())
    expect(resolverCalls).toEqual([])
    expect(calls.map((c) => c.args.p_match)).toEqual(["star-wars", "minnie-mouse"])
  })

  it("Top Shot series labels map to the on-chain number (0 is Series 1)", async () => {
    entityRows = [ENTITY]
    await runMarketCapTool({ grain: "series", name: "Series 1" }, "nba-top-shot", deps())
    await runMarketCapTool({ grain: "series", name: "Series 2023-24" }, "nba-top-shot", deps())
    await runMarketCapTool({ grain: "series", name: "2024" }, "disney-pinnacle", deps())
    expect(calls.map((c) => c.args.p_match)).toEqual(["0", "6", "2024"])
  })

  it("no row → no_results, never a $0 answer", async () => {
    entityRows = []
    const out: any = await runMarketCapTool({ grain: "set", name: "Not A Set" }, "nba-top-shot", deps())
    expect(out.status).toBe("no_results")
    expect(out.market_cap_usd).toBeUndefined()
  })

  it("refuses an unknown collection and an unknown grain without reading", async () => {
    const a: any = await runMarketCapTool({ grain: "player", name: "x" }, "topshot", deps())
    const b: any = await runMarketCapTool({ grain: "wallet" }, "nba-top-shot", deps())
    expect(a.status).toBe("error")
    expect(b.status).toBe("error")
    expect(calls).toHaveLength(0)
  })

  it("a failed read THROWS (the route turns it into a classified error), never an empty answer", async () => {
    rpcError = { message: "canceling statement due to statement timeout" }
    await expect(runMarketCapTool({ grain: "player", name: "lebron" }, "nba-top-shot", deps())).rejects.toThrow()
  })
})

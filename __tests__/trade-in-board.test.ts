import { describe, it, expect } from "vitest"
import { memorySupabase } from "./helpers/memory-supabase"
import {
  ASP_PER_PACK_USD,
  cleanPlayerFilter,
  fetchTradeInBoard,
  fetchTradeInPortfolio,
  fetchTradeInWallet,
  normalizeFill,
  normalizePortfolioRow,
  normalizeTradeInRow,
  tradeInEditionHref,
  type TradeInBoardClient,
} from "@/lib/insights/trade-in-board"

// The board publishes Top Shot's OWN figures (ASP = what the trade-in counts) and
// never a $0: a row without an ASP or an ask is dropped, a wallet's Moments
// without an ASP are counted, not valued, and a typed accent-less name still
// finds the accented player.

const row = (o: Partial<Record<string, unknown>> = {}) => ({
  edition_id: "e1",
  external_id: "90:2968::2",
  player_name: "Nikola Jokić",
  team_name: "Denver Nuggets",
  set_name: "Base Set",
  printing: "Torn",
  tier: "COMMON",
  series: 5,
  circulation_count: 1000,
  live_supply: 817,
  asp: "5.26",
  low_ask: "0.35",
  moments_per_pack: 2,
  cost_per_pack: "0.70",
  asp_to_ask: "15.03",
  asp_at: "2026-10-31T16:13:00Z",
  ...o,
})

describe("trade-in board — rows", () => {
  it("normalizes Top Shot's figures and drops a row that cannot have a cost", () => {
    const r = normalizeTradeInRow(row())!
    expect(r).toMatchObject({ asp: 5.26, low_ask: 0.35, moments_per_pack: 2, cost_per_pack: 0.7, asp_to_ask: 15.03, printing: "Torn" })
    expect(normalizeTradeInRow(row({ asp: null }))).toBeNull()
    expect(normalizeTradeInRow(row({ low_ask: 0 }))).toBeNull()
    expect(normalizeTradeInRow(row({ cost_per_pack: null }))).toBeNull()
    expect(JSON.stringify(r)).not.toMatch(/fmv|confidence/i)
    expect(tradeInEditionHref(r.external_id)).toBe("/nba-top-shot/edition/90%3A2968%3A%3A2")
    expect(ASP_PER_PACK_USD).toBe(10)
  })

  it("a wallet row counts Moments without an ASP separately and never values them", () => {
    expect(normalizePortfolioRow({ player_name: "LeBron James", moments: 92, moments_with_asp: 90, asp_total: "8116.59", packs: 811, to_next_pack: "3.41", total_players: 1332 })).toEqual({
      player_name: "LeBron James",
      moments: 92,
      moments_with_asp: 90,
      asp_total: 8116.59,
      packs: 811,
      to_next_pack: 3.41,
      total_players: 1332,
    })
    expect(normalizePortfolioRow({ player_name: "", moments: 1 })).toBeNull()
  })

  it("strips LIKE wildcards from a typed player so the filter cannot be widened", () => {
    expect(cleanPlayerFilter("  %Jok_ić\\  ")).toBe("Jokić")
    expect(cleanPlayerFilter(null)).toBe("")
    expect(cleanPlayerFilter("a".repeat(100))).toHaveLength(60)
  })
})

describe("trade-in board — reads", () => {
  const seed = { v_insights_trade_in: [row(), row({ edition_id: "e2", player_name: "Stephen Curry", cost_per_pack: "0.40", asp_to_ask: "30" })] }

  it("sorts cheapest first by default with a unique tiebreak, and re-runs an empty accent-less search accent-blind (#207)", async () => {
    const m = memorySupabase(seed)
    const db = m.db as unknown as TradeInBoardClient
    const all = await fetchTradeInBoard(db, { sort: "cost", limit: 10 })
    expect(all.data?.map((r) => r.edition_id)).toEqual(["e2", "e1"])
    m.log.length = 0
    const typed = await fetchTradeInBoard(db, { player: "jokic", sort: "cost", limit: 10 })
    expect(typed.data?.map((r) => r.player_name)).toEqual(["Nikola Jokić"])
    // the retry happened: an ilike pass, then an imatch pass
    expect(m.log.filter((l) => l === "select v_insights_trade_in")).toHaveLength(2)
    const nobody = await fetchTradeInBoard(db, { player: "nobody", sort: "ratio", limit: 10 })
    expect(nobody.data).toEqual([])
  })

  it("a failed read is returned as an error, never as an empty board", async () => {
    const m = memorySupabase(seed)
    m.failNext("select", "v_insights_trade_in", "canceling statement due to statement timeout")
    const r = await fetchTradeInBoard(m.db as unknown as TradeInBoardClient, { sort: "cost", limit: 10 })
    expect(r.data).toBeNull()
    expect(r.error?.message).toMatch(/timeout/)
  })

  it("the wallet arm passes the function its own cap and keeps total_players", async () => {
    const m = memorySupabase({})
    m.rpcs.get_topshot_trade_in_portfolio = (args) => ({
      data: [{ player_name: "LeBron James", moments: 92, moments_with_asp: 92, asp_total: 8116.59, packs: 811, to_next_pack: 3.41, total_players: 1332 }],
      error: args.p_limit === 200 && args.p_wallet === "0xbd94cade097e50ac" ? null : { message: "wrong args" },
    })
    const r = await fetchTradeInPortfolio(m.db as unknown as TradeInBoardClient, "0xbd94cade097e50ac")
    expect(r.error).toBeNull()
    expect(r.data?.[0]).toMatchObject({ packs: 811, total_players: 1332 })
  })

  // 2026-10-31 (afternoon): the one-scan wallet read — players + the cheapest next pack per
  // player. A fill without a price is dropped (never a $0 buy); a non-object answer is a
  // failed read, never an empty wallet; a player with no fill keeps `fill: null`.
  it("normalizeFill drops a fill that has nothing priced to buy", () => {
    const fill = { player_name: "LeBron James", packs: 811, to_next_pack: "3.41", edition_id: "e2", external_id: "26:401", set_name: "Base Set", printing: "Standard", tier: "COMMON", series: 2, asp: "5.25", low_ask: "2.82", moments_needed: 1, cost: "2.82" }
    expect(normalizeFill(fill)).toMatchObject({ player_name: "LeBron James", low_ask: 2.82, moments_needed: 1, cost: 2.82, asp: 5.25 })
    expect(normalizeFill({ ...fill, low_ask: null })).toBeNull()
    expect(normalizeFill({ ...fill, asp: 0 })).toBeNull()
    expect(normalizeFill({ ...fill, moments_needed: 0 })).toBeNull()
    expect(normalizeFill(null)).toBeNull()
  })

  it("fetchTradeInWallet reads players, next_pack and the whole-wallet counts in one call; a bad shape is an error", async () => {
    const m = memorySupabase({})
    const fill = { player_name: "LeBron James", packs: 811, to_next_pack: 3.41, edition_id: "e2", external_id: "26:401", set_name: "Base Set", printing: "Standard", tier: "COMMON", series: 2, asp: 5.25, low_ask: 2.82, moments_needed: 1, cost: 2.82 }
    m.rpcs.get_topshot_trade_in_wallet = (args) => ({
      data: {
        wallet: "0xbd94cade097e50ac",
        total_players: 1323,
        players_with_fill: 1322,
        packs_total: 6723,
        players: [
          { player_name: "LeBron James", moments: 92, moments_with_asp: 92, asp_total: 8116.59, packs: 811, to_next_pack: 3.41, fill },
          { player_name: "Unlisted Guy", moments: 3, moments_with_asp: 2, asp_total: 1.2, packs: 0, to_next_pack: 8.8, fill: null },
        ],
        next_pack: [{ ...fill, player_name: "Jonathan Isaac", packs: 0, to_next_pack: 0.13, asp: 0.21, low_ask: 0.18, cost: 0.18, external_id: "218:8550" }, { ...fill, low_ask: null, cost: null }],
      },
      error: args.p_limit === 200 && args.p_wallet === "0xbd94cade097e50ac" ? null : { message: "wrong args" },
    })
    const r = await fetchTradeInWallet(m.db as unknown as TradeInBoardClient, "0xbd94cade097e50ac")
    expect(r.error).toBeNull()
    expect(r.data).toMatchObject({ total_players: 1323, players_with_fill: 1322, packs_total: 6723 })
    expect(r.data?.players[0]).toMatchObject({ packs: 811, total_players: 1323, fill: { external_id: "26:401", cost: 2.82 } })
    expect(r.data?.players[1].fill).toBeNull()
    // the unpriced fill is dropped from next_pack, never rendered as a $0 buy
    expect(r.data?.next_pack.map((f) => f.player_name)).toEqual(["Jonathan Isaac"])

    m.rpcs.get_topshot_trade_in_wallet = () => ({ data: [], error: null })
    const bad = await fetchTradeInWallet(m.db as unknown as TradeInBoardClient, "0xbd94cade097e50ac")
    expect(bad.data).toBeNull()
    expect(bad.error).not.toBeNull()
  })
})

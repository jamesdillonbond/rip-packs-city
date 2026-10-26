// 2026-10-19 — get_edition_listings had no Panini arm, so every Panini "cheapest one
// listed?" came back listings_status 'unavailable' and the concierge said the live
// check failed — about a book RPC holds (panini_market_board: the lowest ask
// re-confirmed in the last 7 days, the edition page's own ask). Same shape as the
// Candy arm's test (concierge-candy-edition-listings.test.ts).

import { describe, it, expect, beforeEach, vi } from "vitest"
import { NextRequest } from "next/server"
import { makeInstrumentedSupabaseFixture, installFetchMock, jsonRoute } from "./helpers/route-harness"
import type { ScriptTurn } from "./helpers/anthropic-fixture"

const A = vi.hoisted(() => ({
  state: { script: [] as ScriptTurn[], cursor: 0 },
  createCalls: [] as Array<{ messages: Array<{ role: string; content: unknown }> }>,
  sb: null as unknown,
}))
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: () => {} }
})
vi.mock("@/lib/auth/supabase-server", () => ({
  getSupabaseServer: async () => ({ auth: { getUser: async () => ({ data: { user: null }, error: null }) } }),
}))
vi.mock("@/lib/pro-tier", () => ({
  checkFeatureQuota: async () => ({ allowed: true, plan: "pro", daily_limit: 200 }),
  recordFeatureUsage: async () => {},
}))
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => new Proxy({}, { get: (_t, prop) => (A.sb as Record<PropertyKey, unknown>)[prop] }),
}))
vi.mock("@anthropic-ai/sdk", async () => {
  const { buildAnthropicClass } = await import("./helpers/anthropic-fixture")
  const Base = buildAnthropicClass(A.state) as new () => { messages: { create: (args: unknown) => Promise<unknown>; stream: (args: unknown) => unknown } }
  return {
    default: class {
      messages = (() => {
        const inner = new Base().messages
        return {
          create: async (args: unknown) => {
            A.createCalls.push(args as never)
            return inner.create(args)
          },
          stream: inner.stream,
        }
      })()
    },
  }
})
process.env.ANTHROPIC_API_KEY = "test-key"
const { POST } = await import("@/app/api/support-chat/route")

function post(): NextRequest {
  return new NextRequest("https://t/api/support-chat", {
    method: "POST",
    headers: new Headers({ "content-type": "application/json" }),
    body: JSON.stringify({ message: "cheapest one listed?", sessionId: `p-${Math.random()}`, collectionId: "panini-blockchain" }),
  })
}
function toolResult(): Record<string, any> {
  const blocks = A.createCalls.at(-1)?.messages.at(-1)?.content as Array<{ type: string; content: string }>
  const tr = blocks?.find((b) => b.type === "tool_result")
  if (!tr) throw new Error("no tool_result")
  return JSON.parse(tr.content)
}

const KEY = "packcard-2332_486952_12683150_87"
const EDITION = { id: "ed-estevao", external_id: KEY, player_name: "Estevao", set_name: "Base Prizms Black", tier: "ULTIMATE", circulation_count: 1, collection_id: "panini" }
const ago = (h: number) => new Date(Date.now() - h * 3600_000).toISOString()

function install(board: unknown, serials: unknown = { data: [], error: null }) {
  A.sb = makeInstrumentedSupabaseFixture({
    editions: { data: [EDITION], error: null },
    fmv_current: { data: [{ fmv_usd: 120, confidence: "HIGH", edition_id: "ed-estevao" }], error: null },
    panini_market_board: board as never,
    // fetchPaniniEditionSerials reads listed serials, then reported last sales.
    panini_card_serials: [serials, { data: [], error: null }] as never,
  }).fixture
}

beforeEach(() => {
  A.createCalls.length = 0
  A.state.script = [{ tools: [{ name: "get_edition_listings", input: { editionKey: KEY } }] }, { text: "done" }]
  A.state.cursor = 0
})

describe("get_edition_listings — Panini reads RPC's confirmed-ask board (2026-10-19)", () => {
  it("listed: the confirmed low ask is the floor, with its confirmation time and the Panini link", async () => {
    install({ data: [{ low_ask_usd: 95, listed_count: 3, ask_confirmed_at: ago(5) }], error: null })
    await POST(post())
    const r = toolResult()
    expect(r.listings_status).toBe("listed")
    expect(r.floor_ask).toBe(95)
    expect(r.listings_count).toBe(3)
    expect(r.floor_listed_at).toBeTruthy()
    expect(r.floor_buy_url).toBe(`https://nft.paniniamerica.net/marketplace-details/${KEY}.html`)
    expect(String(r.listings_note)).toMatch(/last 7 days/)
  })
  it("no confirmed ask is none_listed — the board answered — not 'unavailable'", async () => {
    install({ data: [], error: null })
    await POST(post())
    const r = toolResult()
    expect(r.listings_status).toBe("none_listed")
    expect(r.floor_ask).toBeNull()
    expect(r.floor_buy_url).toBeNull()
  })
  it("a FAILED board read is 'unavailable', never 'none_listed'", async () => {
    install({ data: null, error: { message: "canceling statement due to statement timeout" } })
    await POST(post())
    const r = toolResult()
    expect(r.listings_status).toBe("unavailable")
    expect(r.floor_ask).toBeNull()
  })
  it("a listed #1 serial is surfaced as a chase serial; a failed serial read says so instead of 'none'", async () => {
    install(
      { data: [{ low_ask_usd: 95, listed_count: 2, ask_confirmed_at: ago(5) }], error: null },
      { data: [{ serial_number: 1, mint_cap: 1, price_usd: 900, captured_at: ago(2), is_number_one: true }, { serial_number: 7, mint_cap: 1, price_usd: 95, captured_at: ago(2) }], error: null },
    )
    await POST(post())
    let r = toolResult()
    expect(r.special_serials_listed).toHaveLength(1)
    expect(r.special_serials_listed[0]).toMatchObject({ serial: 1, ask_usd: 900, tag: "#1" })
    A.createCalls.length = 0
    A.state.cursor = 0
    install({ data: [{ low_ask_usd: 95, listed_count: 2, ask_confirmed_at: ago(5) }], error: null }, { data: null, error: { message: "boom" } })
    await POST(post())
    r = toolResult()
    expect(String(r.special_serials_note)).toMatch(/failed/)
  })
})

describe("check_wallet on a Panini page reads the Panini username — never a Top Shot account of the same name", () => {
  it("routes to /api/panini-collection and never calls resolve_topshot_username", async () => {
    const inst = makeInstrumentedSupabaseFixture({})
    A.sb = inst.fixture
    const f = installFetchMock([jsonRoute("/api/panini-collection", {
      username: "joe", cardsSeen: 1, listedNow: 0, editions: 1, specialSerials: 0, fmvSeenUsd: 10, fmvPricedCards: 1, lastSeenAt: ago(3), cards: [],
      profile: { walk: null, cards: [] },
    })])
    A.state.script = [{ tools: [{ name: "check_wallet", input: { walletAddress: "joe" } }] }, { text: "done" }]
    A.state.cursor = 0
    try {
      await POST(post())
      const r = toolResult()
      expect(r.status).toBe("ok")
      expect(r.username).toBe("joe")
      expect(r.seen_on_marketplace.cards_seen).toBe(1)
      expect(f.calls.some((c) => c.url.includes("/api/panini-collection?username=joe"))).toBe(true)
      expect(inst.rpcCalls.some((c) => c.name === "resolve_topshot_username")).toBe(false)
      expect(inst.rpcCalls.some((c) => c.name === "get_wallet_collection_snapshot")).toBe(false)
    } finally {
      f.restore()
    }
  })
  it("a Flow address on Panini is refused — Panini has no wallets", async () => {
    A.sb = makeInstrumentedSupabaseFixture({}).fixture
    A.state.script = [{ tools: [{ name: "check_wallet", input: { walletAddress: "0x0b2a3299cc857e29" } }] }, { text: "done" }]
    A.state.cursor = 0
    await POST(post())
    expect(toolResult().status).toBe("unsupported_collection")
  })
})

describe("wallet and team tools on a Panini page say what Panini lacks — never 'none found' (2026-10-19)", () => {
  // Panini owners are usernames (no wallets). Without these guards a name resolved as a TOP SHOT
  // username (another person's wallet). Re-pinned 2026-10-25 (premise changed): the TEAM tools left
  // this list — panini_edition_team_keys now places Panini cards on franchises — and are pinned below.
  it.each([
    ["find_quirky_serials", { walletAddress: "joe" }],
    // analyze_wallet_holdings left this list 2026-10-26: it answers Panini over the username
    // (panini_holdings_breakdown) — pinned in its own block below.
  ])("%s is refused on Panini without resolving a Top Shot username or querying a team", async (tool, input) => {
    const inst = makeInstrumentedSupabaseFixture({})
    A.sb = inst.fixture
    A.state.script = [{ tools: [{ name: tool, input }] }, { text: "done" }]
    A.state.cursor = 0
    await POST(post())
    const r = toolResult()
    expect(r.status).toBe("unsupported_collection")
    expect(String(r.message)).toMatch(/Panini/)
    expect(inst.rpcCalls.some((c) => c.name === "resolve_topshot_username")).toBe(false)
  })
})

describe("analyze_wallet_holdings on a Panini page answers over the Panini USERNAME (2026-10-26)", () => {
  const BD = {
    username: "spinotron", source: "profile", last_walk_at: "2026-10-26T12:17:58Z", last_complete_at: null, profile_state: "public",
    reported_total: 7585, total_cards: 7584, cards: 767, fmv_usd: 103880.5, fmv_priced_cards: 758, cards_not_on_a_team: null, cards_sport_unknown: 0,
    groups: [{ key: "WNBA", cards: 767, fmv_usd: 103880.5, fmv_priced_cards: 758 }],
    top_cards: [{ player: "Caitlin Clark", set: "Base", sport: "WNBA", fmv_usd: 900, edition_key: "packcard-1_2_3_4", confidence: "HIGH" }],
  }
  const teams = { "teams_master": { data: [{ league: "NBA", slug: "blazers", team_name: "Portland Trail Blazers" }], error: null } }
  it("reads panini_holdings_breakdown with the username — never the Top Shot resolver — and says which source it covers", async () => {
    const inst = makeInstrumentedSupabaseFixture({ "rpc:panini_holdings_breakdown": { data: BD, error: null } })
    A.sb = inst.fixture
    A.state.script = [{ tools: [{ name: "analyze_wallet_holdings", input: { walletAddress: "Spinotron", sport: "WNBA", groupBy: "sport", tier: "RARE" } }] }, { text: "done" }]
    A.state.cursor = 0
    await POST(post())
    const r = toolResult()
    expect(r.status).toBe("ok")
    expect(r.source).toBe("profile")
    expect(String(r.source_note)).toMatch(/PARTIAL/)
    expect(r.cards).toBe(767)
    expect(r.ignored_filters).toEqual(["tier"])
    expect(r.top_cards[0].edition_url).toMatch(/\/panini-blockchain\/edition\/packcard-1_2_3_4$/)
    expect(JSON.stringify(r)).not.toMatch(/HIGH|MEDIUM|confidence/)
    const call = inst.rpcCalls.find((c) => c.name === "panini_holdings_breakdown")
    expect((call?.args as any)?.p_username).toBe("Spinotron")
    expect((call?.args as any)?.p_sport).toBe("WNBA")
    expect(inst.rpcCalls.some((c) => c.name === "resolve_topshot_username" || c.name === "concierge_wallet_breakdown")).toBe(false)
  })
  it("a team filter resolves to the franchise key and states that team counts are floors", async () => {
    const inst = makeInstrumentedSupabaseFixture({ ...teams, "rpc:panini_holdings_breakdown": { data: { ...BD, source: "seen", cards: 12, cards_not_on_a_team: 3 }, error: null } })
    A.sb = inst.fixture
    A.state.script = [{ tools: [{ name: "analyze_wallet_holdings", input: { walletAddress: "adlcards", team: "Blazers" } }] }, { text: "done" }]
    A.state.cursor = 0
    await POST(post())
    const r = toolResult()
    expect(r.status).toBe("ok")
    expect(String(r.source_note)).toMatch(/NOT the whole collection/)
    expect(r.filters.team).toBe("Portland Trail Blazers")
    expect(String(r.team_note)).toMatch(/floors/)
    expect((inst.rpcCalls.find((c) => c.name === "panini_holdings_breakdown")?.args as any)?.p_franchise_key).toBe("NBA:blazers")
  })
  it("a failed read says the check failed, and a never-seen username is 'not seen', never 'holds nothing'", async () => {
    let inst = makeInstrumentedSupabaseFixture({ "rpc:panini_holdings_breakdown": { data: null, error: { message: "timeout" } } })
    A.sb = inst.fixture
    A.state.script = [{ tools: [{ name: "analyze_wallet_holdings", input: { walletAddress: "adlcards" } }] }, { text: "done" }]
    A.state.cursor = 0
    await POST(post())
    let r = toolResult()
    expect(r.status).toBe("error")
    expect(String(r.message)).toMatch(/never say this collector holds nothing/)
    inst = makeInstrumentedSupabaseFixture({ "rpc:panini_holdings_breakdown": { data: { ...BD, source: "seen", total_cards: 0, cards: 0, groups: [], top_cards: [] }, error: null } })
    A.sb = inst.fixture
    A.state.script = [{ tools: [{ name: "analyze_wallet_holdings", input: { walletAddress: "nobody1" } }] }, { text: "done" }]
    A.state.cursor = 0
    await POST(post())
    r = toolResult()
    expect(r.status).toBe("not_seen")
    expect(String(r.message)).toMatch(/does NOT mean they hold nothing/)
  })
  it("a player typed without accents is searched with the resolver's spelling (#207)", async () => {
    const inst = makeInstrumentedSupabaseFixture({
      "rpc:resolve_player_name": { data: { status: "one", query: "luka doncic", player: { name: "Luka Dončić", labels: ["Luka Dončić"] }, namesakes: [] }, error: null },
      "rpc:panini_holdings_breakdown": { data: BD, error: null },
    })
    A.sb = inst.fixture
    A.state.script = [{ tools: [{ name: "analyze_wallet_holdings", input: { walletAddress: "adlcards", player: "luka doncic" } }] }, { text: "done" }]
    A.state.cursor = 0
    await POST(post())
    expect((inst.rpcCalls.find((c) => c.name === "panini_holdings_breakdown")?.args as any)?.p_player).toBe("Luka Dončić")
    expect((inst.rpcCalls.find((c) => c.name === "resolve_player_name")?.args as any)?.p_collection_id).toBe("d1a0a7f5-609a-49f4-a1a7-4eaac55b020b")
  })
  it("refuses a groupBy Panini has no data for (tier / series)", async () => {
    const inst = makeInstrumentedSupabaseFixture({ "rpc:panini_holdings_breakdown": { data: BD, error: null } })
    A.sb = inst.fixture
    A.state.script = [{ tools: [{ name: "analyze_wallet_holdings", input: { walletAddress: "adlcards", groupBy: "tier" } }] }, { text: "done" }]
    A.state.cursor = 0
    await POST(post())
    expect(toolResult().status).toBe("error")
    expect(inst.rpcCalls.some((c) => c.name === "panini_holdings_breakdown")).toBe(false)
  })
})

describe("team tools on a Panini page answer from the Panini team map (2026-10-25)", () => {
  // Same property as 10-19 — never a Top Shot team lookup, never "no such team" — now with data.
  const lakers = { "teams_master": { data: [
    { league: "NBA", slug: "lakers", team_name: "Los Angeles Lakers" },
    { league: "NFL", slug: "giants", team_name: "New York Giants" },
    { league: "MLB", slug: "giants", team_name: "San Francisco Giants" },
  ], error: null } }
  it.each([
    ["get_team_checklist", { team: "Lakers" }],
    ["get_team_intel", { team: "Lakers" }],
  ])("%s reads the franchise panel, states coverage, links the hub, and never touches the Top Shot resolver", async (tool, input) => {
    const inst = makeInstrumentedSupabaseFixture({
      ...lakers,
      "rpc:get_panini_franchise_panel": { data: { edition_count: 569, player_count: 40, fmv_total_usd: 9000, coverage: { sport: "Basketball", mapped: 10898, catalogued: 11085 } }, error: null },
      "rpc:get_panini_franchise_editions": { data: [{ route_slug: "packcard-1_2_3_4", player_name: "LeBron James", set_name: "Base", fmv_usd: 50, fmv_confidence: "HIGH", circulation_count: 99 }], error: null },
    })
    A.sb = inst.fixture
    A.state.script = [{ tools: [{ name: tool, input }] }, { text: "done" }]
    A.state.cursor = 0
    await POST(post())
    const r = toolResult()
    expect(r.status).toBe("ok")
    expect(r.team).toBe("Los Angeles Lakers")
    expect(String(r.hub_url)).toMatch(/\/teams\/nba\/lakers$/)
    expect(r.coverage.cards_placed_on_a_team).toBe(10898)
    expect(String(r.how_teams_are_assigned)).toMatch(/not counted/)
    expect(JSON.stringify(r)).not.toMatch(/HIGH|MEDIUM|confidence/)
    expect(inst.rpcCalls.some((c) => c.name === "get_panini_franchise_panel" && (c.args as any)?.p_team_slug === "lakers")).toBe(true)
    expect(inst.rpcCalls.some((c) => c.name === "resolve_team_name")).toBe(false)
  })
  it("a team with nothing placed is 'not placed yet', never 'no cards'", async () => {
    const inst = makeInstrumentedSupabaseFixture({ ...lakers, "rpc:get_panini_franchise_panel": { data: null, error: null }, "rpc:get_panini_franchise_editions": { data: [], error: null } })
    A.sb = inst.fixture
    A.state.script = [{ tools: [{ name: "get_team_intel", input: { team: "Lakers" } }] }, { text: "done" }]
    A.state.cursor = 0
    await POST(post())
    const r = toolResult()
    expect(r.status).toBe("none_placed_yet")
    expect(String(r.message)).toMatch(/never that Panini has no cards/)
  })
  it("a name two leagues share asks which", async () => {
    const inst = makeInstrumentedSupabaseFixture({ ...lakers })
    A.sb = inst.fixture
    A.state.script = [{ tools: [{ name: "get_team_checklist", input: { team: "Giants" } }] }, { text: "done" }]
    A.state.cursor = 0
    await POST(post())
    const r = toolResult()
    expect(r.status).toBe("ambiguous")
    expect(r.candidates).toHaveLength(2)
    expect(inst.rpcCalls.some((c) => c.name === "get_panini_franchise_panel")).toBe(false)
  })
  it("a failed panel read says the check failed, never 'no cards'", async () => {
    const inst = makeInstrumentedSupabaseFixture({ ...lakers, "rpc:get_panini_franchise_panel": { data: null, error: { message: "timeout" } } })
    A.sb = inst.fixture
    A.state.script = [{ tools: [{ name: "get_team_intel", input: { team: "Los Angeles Lakers" } }] }, { text: "done" }]
    A.state.cursor = 0
    await POST(post())
    const r = toolResult()
    expect(r.status).toBe("error")
    expect(String(r.message)).toMatch(/check failed/)
  })
})

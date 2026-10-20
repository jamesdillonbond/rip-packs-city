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
  // Panini owners are usernames (no wallets) and 0 of 36,511 Panini editions carry a team.
  // Without these guards a name resolved as a TOP SHOT username (another person's wallet),
  // and a team lookup found nothing and read as "no such team".
  it.each([
    ["find_quirky_serials", { walletAddress: "joe" }],
    ["analyze_wallet_holdings", { walletAddress: "joe" }],
    ["get_team_checklist", { team: "Lakers" }],
    ["get_team_intel", { team: "Lakers" }],
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

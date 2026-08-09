import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"
import {
  makeInstrumentedSupabaseFixture,
  installFetchMock,
  jsonRoute,
  type FetchStub,
} from "./helpers/route-harness"
import type { ScriptTurn } from "./helpers/anthropic-fixture"

// Concierge TOOL-ARM coverage — the DATA-SHAPING (populated-fixture) half.
//
// api-support-chat-tools.test.ts drives the guard / empty / no-data branches of
// each tool; the ~25 bespoke per-tool Supabase fixtures needed to light the
// data-shaping bodies (the maps/formatters/thresholds that turn a DB row into a
// tool_result) were the deferred gap called out in vitest.config.ts. This file
// supplies POPULATED fixtures so those success paths actually run, and asserts on
// the handler-COMPUTED fields (avg/discount/first-mint/EV-vs-price rollups), not
// just that a fixture echoed back. Same harness + mocks as the sibling file.

const A = vi.hoisted(() => ({
  state: { script: [] as ScriptTurn[], cursor: 0 },
  createCalls: [] as Array<{ messages: Array<{ role: string; content: unknown }> }>,
  sb: null as unknown,
  authedEmail: null as string | null,
}))

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: () => {} }
})
vi.mock("@/lib/auth/supabase-server", () => ({
  getSupabaseServer: async () => ({
    auth: {
      getUser: async () =>
        A.authedEmail
          ? { data: { user: { id: "user-1", email: A.authedEmail } }, error: null }
          : { data: { user: null }, error: null },
    },
  }),
}))
vi.mock("@/lib/pro-tier", () => ({
  checkFeatureQuota: async () => ({ allowed: true, plan: "pro", daily_limit: 200 }),
  recordFeatureUsage: async () => {},
}))
vi.mock("@supabase/supabase-js", () => ({
  createClient: () =>
    new Proxy({}, { get: (_t, prop) => (A.sb as Record<PropertyKey, unknown>)[prop] }),
}))
vi.mock("@anthropic-ai/sdk", async () => {
  const { buildAnthropicClass } = await import("./helpers/anthropic-fixture")
  const Base = buildAnthropicClass(A.state) as new () => {
    messages: { create: (args: unknown) => Promise<unknown>; stream: (args: unknown) => unknown }
  }
  return {
    default: class {
      messages = (() => {
        const inner = new Base().messages
        return {
          create: async (args: unknown) => {
            A.createCalls.push(args as { messages: Array<{ role: string; content: unknown }> })
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

type Fixtures = Parameters<typeof makeInstrumentedSupabaseFixture>[0]
function install(fixtures: Fixtures) {
  const spy = makeInstrumentedSupabaseFixture(fixtures)
  A.sb = spy.fixture
  return spy
}

function post(message: string, extra: Record<string, unknown> = {}): NextRequest {
  return new NextRequest("https://t/api/support-chat", {
    method: "POST",
    headers: new Headers({ "content-type": "application/json" }),
    body: JSON.stringify({ message, sessionId: `pop-${Math.random()}`, ...extra }),
  })
}

function script(toolName: string, input: unknown) {
  A.state.script = [{ tools: [{ name: toolName, input }] }, { text: "done" }]
  A.state.cursor = 0
}

/** The tool_result JSON the handler produced, as fed to iteration 2. */
function toolResult(): Record<string, unknown> {
  const secondCall = A.createCalls.at(-1)
  const lastMsg = secondCall?.messages.at(-1)
  const blocks = lastMsg?.content as Array<{ type: string; content: string }>
  const tr = blocks?.find((b) => b.type === "tool_result")
  if (!tr) throw new Error("no tool_result in the follow-up model call")
  return JSON.parse(tr.content)
}

let fetchMock: ReturnType<typeof installFetchMock> | null = null
function stubFetch(stubs: FetchStub[]) {
  fetchMock = installFetchMock(stubs)
  return fetchMock
}
afterEach(() => {
  fetchMock?.restore()
  fetchMock = null
})
beforeEach(() => {
  install({})
  A.createCalls.length = 0
  A.authedEmail = null
})

const WALLET = "0xbd94cade097e50ac"

describe("concierge tools — check_wallet indexed-cache success path", () => {
  it("returns full-portfolio totals, the per-collection detail, and the standing best-offer total", async () => {
    install({
      "rpc:get_wallet_collection_snapshot": {
        data: {
          totalMoments: 42,
          totalFmv: 5123.5,
          perCollection: [{ slug: "nba_top_shot", moments: 30, fmv: 4000 }],
          topMoments: [{ player: "Dame", fmv: 900 }],
          rarest: { player: "Dame", serial: 1 },
          badgeCount: 7,
        },
        error: null,
      },
      wallet_moments_cache: {
        data: [
          { player_name: "Dame", set_name: "Base", tier: "RARE", serial_number: 1, mint_count: 499, fmv_usd: 900 },
        ],
        error: null,
      },
      "rpc:get_wallet_best_offer_total": { data: 2500, error: null },
    })
    // collectionId in the request body populates effectiveCollectionUuid so the
    // per-collection detail branch (wmc top-moments) runs.
    script("check_wallet", { walletAddress: WALLET })
    await POST(post("what's my portfolio worth?", { collectionId: "nba-top-shot" }))

    const r = toolResult()
    expect(r.status).toBe("ok")
    expect(r.source).toBe("indexed_cache")
    expect(r.total_moments_all_collections).toBe(42)
    expect(r.total_fmv_all_collections).toBe(5123.5)
    expect((r.per_collection as unknown[]).length).toBe(1)
    // The standing-best-offer total is a bid signal, folded in when > 0.
    expect(r.standing_best_offer_total_usd).toBe(2500)
    // collection_detail is built from perCollection + the wmc top-moments query.
    const cd = r.collection_detail as Record<string, unknown>
    expect(cd.total_moments).toBe(30)
    expect((cd.top_moments as Array<Record<string, unknown>>)[0]).toMatchObject({ player: "Dame", serial: 1 })
  })

  it("omits the best-offer total when it is zero (never surfaces a $0 bid)", async () => {
    install({
      "rpc:get_wallet_collection_snapshot": {
        data: { totalMoments: 3, totalFmv: 60, perCollection: [], topMoments: [] },
        error: null,
      },
      "rpc:get_wallet_best_offer_total": { data: 0, error: null },
    })
    script("check_wallet", { walletAddress: WALLET })
    await POST(post("portfolio?"))
    const r = toolResult()
    expect(r.status).toBe("ok")
    expect(r).not.toHaveProperty("standing_best_offer_total_usd")
    // No collectionId in the request → no per-collection detail block.
    expect(r).not.toHaveProperty("collection_detail")
  })

  it("resolves a username via the cache RPC before pulling the snapshot", async () => {
    install({
      "rpc:resolve_topshot_username": { data: { found: true, wallet_address: WALLET.slice(2) }, error: null },
      "rpc:get_wallet_collection_snapshot": {
        data: { totalMoments: 5, totalFmv: 99, perCollection: [], topMoments: [] },
        error: null,
      },
      "rpc:get_wallet_best_offer_total": { data: null, error: null },
    })
    script("check_wallet", { walletAddress: "jamesdillonbond" })
    await POST(post("what does jamesdillonbond hold"))
    const r = toolResult()
    expect(r.status).toBe("ok")
    // The bare-hex RPC result was 0x-normalized into the wallet key.
    expect(r.wallet).toBe(WALLET)
    expect(r.username_input).toBe("jamesdillonbond")
  })
})

describe("concierge tools — analyze_wallet_holdings breakdown", () => {
  it("passes the resolved wallet + filters to the breakdown RPC and shapes the result", async () => {
    const spy = install({
      "rpc:concierge_wallet_breakdown": {
        data: {
          total_moments: 30,
          total_fmv: 4000,
          groups: [{ key: "Damian Lillard", moments: 12, fmv: 2200 }],
        },
        error: null,
      },
    })
    script("analyze_wallet_holdings", { walletAddress: WALLET, groupBy: "player", limit: 5 })
    await POST(post("break my wallet down by player"))
    const r = toolResult()
    expect(r.collection).toBe("nba-top-shot")
    expect((r.groups as unknown[]).length).toBe(1)
    const call = spy.rpcCalls.find((c) => c.name === "concierge_wallet_breakdown")
    expect(call?.args).toMatchObject({ p_wallet: WALLET, p_group_by: "player", p_limit: 5 })
  })

  it("rejects an invalid groupBy without calling the breakdown RPC", async () => {
    const spy = install({})
    script("analyze_wallet_holdings", { walletAddress: WALLET, groupBy: "colour" })
    await POST(post("group by colour"))
    expect(toolResult()).toMatchObject({ status: "error" })
    expect(spy.rpcCalls.some((c) => c.name === "concierge_wallet_breakdown")).toBe(false)
  })
})

describe("concierge tools — explain_fmv", () => {
  it("shapes the plain-English explanation from the edition + latest snapshot", async () => {
    install({
      editions: { data: { id: "ed-1", player_name: "Dame", set_name: "Base", tier: "RARE" }, error: null },
      fmv_snapshots: {
        data: {
          fmv_usd: 120,
          confidence: "HIGH",
          wap_usd: 110,
          floor_price_usd: 95,
          computed_at: new Date().toISOString(),
          sales_count_30d: 8,
          days_since_sale: 1,
          ask_proxy_fmv: 130,
          algo_version: "1.7.0",
        },
        error: null,
      },
    })
    script("explain_fmv", { editionKey: "3:45" })
    await POST(post("why is this priced like that"))
    const r = toolResult()
    expect(r.status).toBe("ok")
    expect(r.player_name).toBe("Dame")
    expect(r.fmv_usd).toBe(120)
    expect(String(r.explanation)).toContain("$120.00")
    expect(String(r.explanation)).toContain("across 8 recent sales")
    // Never echoes the raw confidence enum inside the prose.
    expect(String(r.explanation)).not.toContain("HIGH")
  })

  it("returns not_found when the edition key resolves to nothing", async () => {
    install({ editions: { data: null, error: null } })
    script("explain_fmv", { editionKey: "9:99" })
    await POST(post("explain 9:99"))
    expect(toolResult()).toMatchObject({ status: "not_found" })
  })

  it("returns no_data when the edition exists but has no snapshot", async () => {
    install({
      editions: { data: { id: "ed-2", player_name: "Scoot" }, error: null },
      fmv_snapshots: { data: null, error: null },
    })
    script("explain_fmv", { editionKey: "3:46" })
    await POST(post("explain 3:46"))
    expect(toolResult()).toMatchObject({ status: "no_data" })
  })
})

describe("concierge tools — get_special_serial_owners", () => {
  it("shapes the board rows with the edition URL and kind tag", async () => {
    install({
      "rpc:get_special_serial_owners_board": {
        data: [
          {
            player_name: "Dame",
            set_name: "Base",
            tier: "LEGENDARY",
            serial: 1,
            circulation_count: 99,
            tag: "#1",
            holder_address: WALLET,
            edition_fmv: 4200,
            edition_key: "3:45",
          },
        ],
        error: null,
      },
    })
    script("get_special_serial_owners", { playerName: "Dame", tag: "#1" })
    await POST(post("who owns the #1 Dame"))
    const r = toolResult()
    expect(r.status).toBe("ok")
    expect(r.total).toBe(1)
    const row = (r.rows as Array<Record<string, unknown>>)[0]
    expect(row).toMatchObject({ player: "Dame", serial: 1, kind: "#1", holder: WALLET, edition_fmv: 4200 })
    expect(String(row.edition_url)).toContain("/nba-top-shot/edition/3%3A45")
  })

  it("asks for input when no filter is provided (never dumps the whole board)", async () => {
    install({})
    script("get_special_serial_owners", {})
    await POST(post("special serials?"))
    expect(toolResult()).toMatchObject({ status: "need_input" })
  })
})

describe("concierge tools — search_serial_deals", () => {
  it("shapes the underpriced-serials board (tight estimates first, deepest discount)", async () => {
    install({
      topshot_underpriced_serials_board: {
        data: [
          {
            player_name: "Scoot", set_name: "Base", tier: "COMMON", serial_number: 7,
            circulation_count: 12000, ask_usd: 4, serial_fmv_usd: 6, edition_fmv_usd: 5,
            serial_multiplier: 1.2, discount_pct: 33, estimate_quality: "coarse",
            confidence: "MEDIUM", nft_id: "111", edition_key: "3:45", external_id: "3:45",
          },
          {
            player_name: "Dame", set_name: "Base", tier: "RARE", serial_number: 1,
            circulation_count: 499, ask_usd: 80, serial_fmv_usd: 200, edition_fmv_usd: 150,
            serial_multiplier: 2.0, discount_pct: 60, estimate_quality: "tight",
            confidence: "HIGH", nft_id: "222", edition_key: "3:46", external_id: "3:46",
          },
        ],
        error: null,
      },
    })
    script("search_serial_deals", { limit: 5 })
    await POST(post("underpriced special serials"))
    const r = toolResult()
    expect(r.status).toBe("ok")
    expect(r.source).toBe("underpriced_serials_board")
    const rows = r.rows as Array<Record<string, unknown>>
    // 'tight' estimate is sorted ahead of 'coarse' despite lower listing order.
    expect(rows[0]).toMatchObject({ player: "Dame", serial: 1, is_first_mint: true, estimate_quality: "tight" })
    expect(rows[0].buy_url).toBeTruthy()
  })

  it("listedOnly=true joins editions and computes discount vs serial-FMV", async () => {
    install({
      topshot_active_listings: {
        data: [
          {
            serial_number: 25, nft_id: "333", ask_usd: 50, serial_fmv_usd: 100, edition_key: "3:47", edition_id: "ed-3",
            editions: {
              player_name: "Ant", set_name: "Base", tier: "RARE", circulation_count: 25,
              collection_id: "95f28a17-224a-4025-96ad-adf8a4c63bfd", team_name: "Wolves", external_id: "3:47",
            },
          },
        ],
        error: null,
      },
    })
    script("search_serial_deals", { listedOnly: true, limit: 5 })
    await POST(post("all listed special serials"))
    const r = toolResult()
    expect(r.status).toBe("ok")
    expect(r.source).toBe("active_listings")
    const row = (r.rows as Array<Record<string, unknown>>)[0]
    // serial == circulation → perfect mint; discount = (100-50)/100 = 50%.
    expect(row).toMatchObject({ player: "Ant", is_perfect_mint: true, discount_pct: 50 })
  })
})

describe("concierge tools — search_live_deals", () => {
  it("routes a team query to the concierge_market_deals board", async () => {
    const spy = install({
      "rpc:concierge_market_deals": {
        data: { deals: [{ player: "Dame", ask: 5, fmv: 8, discount_pct: 37 }], count: 1 },
        error: null,
      },
    })
    script("search_live_deals", { team: "Trail Blazers", limit: 5 })
    await POST(post("best Blazers deal"))
    const r = toolResult()
    expect(r.source).toBe("deals_board")
    expect((r.deals as unknown[]).length).toBe(1)
    expect(spy.rpcCalls.some((c) => c.name === "concierge_market_deals")).toBe(true)
  })

  it("shapes sniper-feed rows for a non-team query", async () => {
    stubFetch([
      jsonRoute("/api/sniper-feed", {
        deals: [
          { playerName: "Dame", tier: "RARE", serialNumber: 12, askPrice: 20, adjustedFmv: 35, discount: 43, source: "flowty", buyUrl: "https://x" },
        ],
      }),
    ])
    script("search_live_deals", { limit: 5 })
    await POST(post("any deals right now"))
    const r = toolResult()
    expect(r.status).toBe("ok")
    const row = (r.results as Array<Record<string, unknown>>)[0]
    expect(row).toMatchObject({ player: "Dame", price: 20, fmv: 35, discount_pct: 43, source: "flowty" })
  })

  it("falls back to cached_listings when the sniper feed is empty", async () => {
    stubFetch([jsonRoute("/api/sniper-feed", { deals: [] })])
    install({
      cached_listings: {
        data: [
          { player_name: "Scoot", set_name: "Base", tier: "COMMON", serial_number: 900, circulation_count: 12000, ask_price: 3, fmv: 5, discount: 40, badge_slugs: null, buy_url: "https://y", collection_id: null },
        ],
        error: null,
      },
    })
    script("search_live_deals", { limit: 5 })
    await POST(post("deals fallback"))
    const r = toolResult()
    expect(r.status).toBe("ok")
    expect(r.source).toBe("catalog_fallback")
    expect((r.results as Array<Record<string, unknown>>)[0]).toMatchObject({ player: "Scoot", discount_pct: 40 })
  })
})

describe("concierge tools — compare_pack_value", () => {
  it("computes EV-vs-current-price economics and filters by maxPrice", async () => {
    install({
      pack_table_rows: {
        data: [
          {
            collection_slug: "nba-top-shot", collection_name: "NBA Top Shot", title: "Base Pack", tier: "COMMON",
            retail_price_usd: 9, primary_price: 9, secondary_ask: null, price_source: "primary",
            pack_ev: 18, value_ratio: 2.0, ev_margin_pct: 100, is_positive_ev: true,
            primary_available: true, secondary_available: false, fmv_coverage_pct: 90,
          },
          {
            collection_slug: "nba-top-shot", collection_name: "NBA Top Shot", title: "Whale Pack", tier: "LEGENDARY",
            retail_price_usd: 999, primary_price: null, secondary_ask: 999, price_source: "secondary",
            pack_ev: 500, value_ratio: 0.5, ev_margin_pct: -50, is_positive_ev: false,
            primary_available: false, secondary_available: true, fmv_coverage_pct: 80,
          },
        ],
        error: null,
      },
    })
    script("compare_pack_value", { maxPrice: 20, limit: 10 })
    await POST(post("best pack EV under $20"))
    const r = toolResult()
    expect(r.status).toBe("ok")
    const packs = r.packs as Array<Record<string, unknown>>
    // Only the $9 pack survives the maxPrice filter; the $999 one is dropped.
    expect(packs).toHaveLength(1)
    expect(packs[0]).toMatchObject({
      pack: "Base Pack",
      current_price: 9,
      ev_vs_current_price_ratio: 2,
      positive_ev_at_current_price: true,
    })
  })
})

describe("concierge tools — search_catalog_deals", () => {
  it("shapes cached_listings rows into deal cards", async () => {
    install({
      cached_listings: {
        data: [
          { player_name: "Dame", set_name: "Base", tier: "RARE", serial_number: 3, circulation_count: 499, ask_price: 40, fmv: 70, discount: 43, badge_slugs: ["rookie"], buy_url: "https://z", collection_id: null },
        ],
        error: null,
      },
    })
    script("search_catalog_deals", { player: "Dame", limit: 8 })
    await POST(post("Dame catalog deals"))
    const r = toolResult()
    expect(r.status).toBe("ok")
    expect(r.total).toBe(1)
    expect((r.results as Array<Record<string, unknown>>)[0]).toMatchObject({ player: "Dame", price: 40, fmv: 70, discount_pct: 43 })
  })
})

describe("concierge tools — get_edition_sweep", () => {
  it("resolves the edition then spreads the sweep-signal RPC result", async () => {
    install({
      editions: { data: { id: "ed-9" }, error: null },
      "rpc:get_edition_sweep_signal": {
        data: { quick_buy_sales: 20, swept_sales: 12, swept_share: 0.6 },
        error: null,
      },
    })
    script("get_edition_sweep", { editionKey: "258:8912", days: 14 })
    await POST(post("is 258:8912 being swept"))
    const r = toolResult()
    expect(r.status).toBe("ok")
    expect(r.editionKey).toBe("258:8912")
    expect(r.swept_share).toBe(0.6)
  })

  it("rejects a non setID:playID key without touching the DB", async () => {
    const spy = install({})
    script("get_edition_sweep", { editionKey: "not-a-key" })
    await POST(post("sweep for not-a-key"))
    expect(toolResult()).toMatchObject({ status: "error" })
    expect(spy.rpcCalls.some((c) => c.name === "get_edition_sweep_signal")).toBe(false)
  })

  it("returns not_found when the edition key has no Top Shot row", async () => {
    install({ editions: { data: null, error: null } })
    script("get_edition_sweep", { editionKey: "999:999" })
    await POST(post("sweep 999:999"))
    expect(toolResult()).toMatchObject({ status: "not_found" })
  })
})

describe("concierge tools — get_set_completion_cost", () => {
  it("resolves a single set and shapes the completion plan", async () => {
    install({
      sets: { data: [{ id: "set-1", name: "Base Set", series: 4, set_id_onchain: 258 }], error: null },
      "rpc:get_topshot_set_completion_plan": {
        data: {
          set_name: "Base Set", series: 4, total_plays: 50, owned_plays: 40, missing_plays: 10,
          missing_with_listing: 8, total_floor_cost: 300, total_fmv_missing: 420, cheapest_missing: 5,
          missing: [{ player_name: "Ant", tier: "COMMON", low_ask: 5, fmv_usd: 7 }],
        },
        error: null,
      },
    })
    script("get_set_completion_cost", { setName: "Base Set", walletAddress: WALLET })
    await POST(post("cost to finish Base Set"))
    const r = toolResult()
    expect(r.status).toBe("ok")
    expect(r.cost_to_complete_at_floor_usd).toBe(300)
    expect(r.missing_fmv_usd).toBe(420)
    expect((r.cheapest_first_missing as unknown[]).length).toBe(1)
  })

  it("returns ambiguous_set with candidates when the name matches multiple sets", async () => {
    install({
      sets: {
        data: [
          { id: "set-1", name: "Base Set", series: 3 },
          { id: "set-2", name: "Base Set", series: 4 },
        ],
        error: null,
      },
    })
    script("get_set_completion_cost", { setName: "Base Set", walletAddress: WALLET })
    await POST(post("finish Base Set"))
    const r = toolResult()
    expect(r.status).toBe("ambiguous_set")
    expect((r.candidates as unknown[]).length).toBe(2)
  })

  it("returns set_not_found when no set matches", async () => {
    install({ sets: { data: [], error: null } })
    script("get_set_completion_cost", { setName: "Nonexistent", walletAddress: WALLET })
    await POST(post("finish Nonexistent"))
    expect(toolResult()).toMatchObject({ status: "set_not_found" })
  })

  it("asks for the 0x address when the username cannot be resolved", async () => {
    install({
      sets: { data: [{ id: "set-1", name: "Base Set", series: 4 }], error: null },
      "rpc:resolve_topshot_username": { data: { found: false }, error: null },
    })
    script("get_set_completion_cost", { setName: "Base Set", walletAddress: "ghost-user" })
    await POST(post("finish Base Set for ghost-user"))
    expect(toolResult()).toMatchObject({ status: "username_not_resolved" })
  })
})

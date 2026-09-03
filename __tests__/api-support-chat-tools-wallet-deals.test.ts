import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"
import {
  makeInstrumentedSupabaseFixture,
  installFetchMock,
  jsonRoute,
  type FetchStub,
} from "./helpers/route-harness"
import type { ScriptTurn } from "./helpers/anthropic-fixture"

// Concierge TOOL-ARM coverage for the six executeTool branches that had NO
// test at all — the wallet-analysis + deal-search family, which is where the
// support-chat route's uncovered branches concentrate. Drives each tool through
// the real loop (scripted single tool_use turn) and asserts the tool_result
// JSON the handler feeds back to the model: the resolution ladders, the input
// guards, the honest-empty vs error distinction, and the buyable-EV economics
// (all live user-facing behavior, not incidental).

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
process.env.INGEST_SECRET_TOKEN = "ingest-secret"

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
    body: JSON.stringify({ message, sessionId: `wd-${Math.random()}`, ...extra }),
  })
}
function script(toolName: string, input: unknown) {
  A.state.script = [{ tools: [{ name: toolName, input }] }, { text: "done" }]
  A.state.cursor = 0
}
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

const HEX = "0x1234567890abcdef"

describe("analyze_wallet_holdings", () => {
  it("returns username_not_resolved when a non-hex handle resolves nowhere (never invents a wallet)", async () => {
    install({ "rpc:resolve_topshot_username": { data: { found: false }, error: null } })
    stubFetch([jsonRoute("/api/resolve-topshot-username", { found: false })])
    script("analyze_wallet_holdings", { walletAddress: "ghost_user" })
    await POST(post("break down ghost_user"))
    expect(toolResult()).toMatchObject({ status: "username_not_resolved", wallet: "ghost_user" })
  })

  it("rejects an out-of-vocabulary groupBy before hitting the DB", async () => {
    script("analyze_wallet_holdings", { walletAddress: HEX, groupBy: "colour" })
    await POST(post("group my wallet by colour"))
    expect(toolResult()).toMatchObject({ status: "error" })
    expect(String(toolResult().message)).toContain("groupBy must be one of")
  })

  it("errors on an unknown collection slug", async () => {
    script("analyze_wallet_holdings", { walletAddress: HEX, collectionId: "pokemon" })
    await POST(post("analyze"))
    expect(toolResult()).toMatchObject({ status: "error" })
    expect(String(toolResult().message)).toContain("Unknown collection")
  })

  it("returns the breakdown for a hex wallet, tagged with the collection + full-wallet note", async () => {
    install({
      "rpc:concierge_wallet_breakdown": {
        data: { total_moments: 42, total_fmv: 1234.5, groups: [{ key: "Blazers", count: 12 }] },
        error: null,
      },
    })
    script("analyze_wallet_holdings", { walletAddress: HEX, groupBy: "team" })
    await POST(post("break down my wallet by team"))
    const r = toolResult()
    expect(r).toMatchObject({ total_moments: 42, collection: "nba-top-shot" })
    expect(r.groups).toBeTruthy()
    expect(String(r.note)).toContain("FULL indexed wallet")
  })

  it("surfaces the breakdown RPC error rather than a partial answer", async () => {
    install({ "rpc:concierge_wallet_breakdown": { data: null, error: { message: "timeout acquiring connection" } } })
    script("analyze_wallet_holdings", { walletAddress: HEX })
    await POST(post("analyze"))
    // The driver message must NOT be published — lib/api-error.ts classifies it.
    expect(toolResult()).toMatchObject({ status: "error" })
    expect(String((toolResult() as { message?: string }).message ?? "")).not.toContain("timeout acquiring connection")
  })
})

describe("check_wallet_squeeze", () => {
  it("returns username_not_resolved for an unknown handle", async () => {
    install({ "rpc:resolve_topshot_username": { data: { found: false }, error: null } })
    stubFetch([jsonRoute("/api/resolve-topshot-username", { found: false })])
    script("check_wallet_squeeze", { walletAddress: "nobody" })
    await POST(post("squeeze for nobody"))
    expect(toolResult()).toMatchObject({ status: "username_not_resolved" })
  })

  it("returns an honest empty (not an error) when no moments are cached for the wallet", async () => {
    install({ "rpc:get_wallet_squeeze_exposure": { data: { total_moments: 0 }, error: null } })
    script("check_wallet_squeeze", { walletAddress: HEX })
    await POST(post("squeeze me"))
    expect(toolResult()).toMatchObject({ status: "empty", wallet: HEX })
  })

  it("returns the squeeze summary for a wallet with holdings", async () => {
    install({
      "rpc:get_wallet_squeeze_exposure": {
        data: { total_moments: 30, buckets: { deep: 3 }, total_squeeze_usd: 500 },
        error: null,
      },
    })
    script("check_wallet_squeeze", { walletAddress: HEX })
    await POST(post("squeeze me"))
    const r = toolResult()
    expect(r).toMatchObject({ status: "ok", wallet: HEX })
    expect((r.summary as Record<string, unknown>).total_moments).toBe(30)
  })

  it("surfaces the exposure RPC error", async () => {
    install({ "rpc:get_wallet_squeeze_exposure": { data: null, error: { message: "boom" } } })
    script("check_wallet_squeeze", { walletAddress: HEX })
    await POST(post("squeeze"))
    // The driver message must NOT be published — lib/api-error.ts classifies it.
    expect(toolResult()).toMatchObject({ status: "error" })
    expect(String((toolResult() as { message?: string }).message ?? "")).not.toContain("boom")
  })
})

describe("compare_pack_value", () => {
  it("judges 'worth buying now' by EV-vs-current-price, not the retail-anchored site ratio", async () => {
    // A sold-out pack: only buyable at the secondary ask ($100), EV $80 -> the
    // buyable ratio is 0.8 (NOT positive) even though the retail-based site
    // value_ratio (1.6) looks great. Pins the 2026-07-11 buyable-economics rule.
    install({
      pack_table_rows: {
        data: [
          {
            collection_slug: "nba-top-shot",
            collection_name: "NBA Top Shot",
            title: "Sold-Out Pack",
            tier: "common",
            retail_price_usd: 50,
            primary_price: 50,
            secondary_ask: 100,
            price_source: "secondary",
            pack_ev: 80,
            value_ratio: 1.6,
            is_positive_ev: true,
            primary_available: false,
            secondary_available: true,
          },
        ],
        error: null,
      },
    })
    script("compare_pack_value", {})
    await POST(post("best pack to buy?"))
    const r = toolResult()
    expect(r).toMatchObject({ status: "ok" })
    const pack = (r.packs as Array<Record<string, unknown>>)[0]
    expect(pack).toMatchObject({
      current_price: 100,
      price_source: "secondary",
      pack_ev: 80,
      ev_vs_current_price_ratio: 0.8,
      positive_ev_at_current_price: false,
      site_value_ratio_retail_based: 1.6,
    })
  })

  it("filters by the BUYABLE price after computing it (maxPrice under the secondary ask -> no_results)", async () => {
    install({
      pack_table_rows: {
        data: [
          {
            collection_slug: "nba-top-shot",
            title: "Pricey Pack",
            tier: "rare",
            retail_price_usd: 50,
            primary_price: 50,
            secondary_ask: 100,
            price_source: "secondary",
            pack_ev: 200,
            value_ratio: 4,
            primary_available: false,
            secondary_available: true,
          },
        ],
        error: null,
      },
    })
    script("compare_pack_value", { maxPrice: 40 })
    await POST(post("best pack under $40?"))
    expect(toolResult()).toMatchObject({ status: "no_results" })
  })

  it("surfaces the pack query error", async () => {
    install({ pack_table_rows: { data: null, error: { message: "relation missing" } } })
    script("compare_pack_value", {})
    await POST(post("packs"))
    // The driver message must NOT be published — lib/api-error.ts classifies it.
    expect(toolResult()).toMatchObject({ status: "error" })
    expect(String((toolResult() as { message?: string }).message ?? "")).not.toContain("relation missing")
  })
})

describe("search_catalog_deals", () => {
  it("maps cached_listings rows into deal results", async () => {
    install({
      cached_listings: {
        data: [
          { player_name: "Damian Lillard", set_name: "Base Set", tier: "RARE", serial_number: 7, ask_price: "40", fmv: "60", discount: "33", badge_slugs: ["rookie"], buy_url: "https://x/1" },
        ],
        error: null,
      },
    })
    script("search_catalog_deals", { player: "Lillard" })
    await POST(post("catalog deals for Lillard"))
    const r = toolResult()
    expect(r).toMatchObject({ status: "ok", total: 1 })
    expect((r.results as Array<Record<string, unknown>>)[0]).toMatchObject({
      player: "Damian Lillard",
      price: 40,
      fmv: 60,
      discount_pct: 33,
    })
  })

  it("surfaces a cached_listings query error", async () => {
    install({ cached_listings: { data: null, error: { message: "listings unavailable" } } })
    script("search_catalog_deals", { player: "Nobody" })
    await POST(post("deals"))
    // The driver message must NOT be published — lib/api-error.ts classifies it.
    expect(toolResult()).toMatchObject({ status: "error" })
    expect(String((toolResult() as { message?: string }).message ?? "")).not.toContain("listings unavailable")
  })
})

describe("search_live_deals", () => {
  it("routes a team query to the edition-grain deals board (the sniper feed has no team dimension)", async () => {
    install({
      "rpc:concierge_market_deals": {
        data: { deals: [{ player: "Anfernee Simons", ask: 30, fmv: 55 }], count: 1 },
        error: null,
      },
    })
    script("search_live_deals", { team: "Trail Blazers", collectionId: "nba-top-shot" })
    await POST(post("best Blazers deal"))
    const r = toolResult()
    expect(r).toMatchObject({ source: "deals_board" })
    expect(String(r.note)).toContain("insights/deals")
    expect(r.deals).toBeTruthy()
  })
})

describe("search_serial_deals", () => {
  it("returns the underpriced-serials board, tight estimates ranked ahead of coarse", async () => {
    install({
      topshot_underpriced_serials_board: {
        data: [
          { player_name: "A", set_name: "S", tier: "RARE", serial_number: 5, circulation_count: 100, ask_usd: "20", serial_fmv_usd: "40", edition_fmv_usd: "30", discount_pct: "50", estimate_quality: "coarse", confidence: "LOW", nft_id: "111", external_id: "1:1" },
          { player_name: "B", set_name: "S", tier: "RARE", serial_number: 1, circulation_count: 50, ask_usd: "10", serial_fmv_usd: "25", edition_fmv_usd: "20", discount_pct: "30", estimate_quality: "tight", confidence: "HIGH", nft_id: "222", external_id: "2:2" },
        ],
        error: null,
      },
    })
    script("search_serial_deals", { limit: 10 })
    await POST(post("underpriced serials"))
    const r = toolResult()
    expect(r).toMatchObject({ status: "ok", source: "underpriced_serials_board" })
    const rows = r.rows as Array<Record<string, unknown>>
    // 'tight' estimate sorts first even though its discount is lower.
    expect(rows[0]).toMatchObject({ player: "B", estimate_quality: "tight", is_first_mint: true })
    expect(rows[1]).toMatchObject({ player: "A", estimate_quality: "coarse" })
  })

  it("returns an honest empty (not error) when nothing is listed below serial-FMV", async () => {
    install({ topshot_underpriced_serials_board: { data: [], error: null } })
    script("search_serial_deals", { player: "Nobody" })
    await POST(post("underpriced serials for Nobody"))
    const r = toolResult()
    expect(r).toMatchObject({ status: "no_results", source: "underpriced_serials_board" })
    expect(String(r.message)).toContain("listedOnly=true")
  })

  it("surfaces the board query error", async () => {
    install({ topshot_underpriced_serials_board: { data: null, error: { message: "board down" } } })
    script("search_serial_deals", {})
    await POST(post("serials"))
    // The driver message must NOT be published — lib/api-error.ts classifies it.
    expect(toolResult()).toMatchObject({ status: "error" })
    expect(String((toolResult() as { message?: string }).message ?? "")).not.toContain("board down")
  })
})

// ── 2026-09-03: "buyable" is freshness-gated, and the row says when it was seen ──
//
// primary_available / secondary_available / secondary_ask are columns on the
// pack_ev_latest snapshot, exactly as fresh as ev_snapshotted_at. Measured the
// day this landed: 654 of 1,210 Top Shot rows over three days old still said
// secondary_available, the oldest 135 days — and this tool told the model they
// were buyable +EV now. The fixture returns whatever it is given, so the gate
// is a claim about the QUERY and is pinned by recording what was asked.
describe("compare_pack_value — the buyable filter is freshness-gated", () => {
  it("applies an ev_snapshotted_at lower bound inside the 72 h bar and reports ev_as_of on each row", async () => {
    install({
      pack_table_rows: {
        data: [
          {
            collection_slug: "nba-top-shot",
            collection_name: "NBA Top Shot",
            title: "Fresh Pack",
            tier: "common",
            retail_price_usd: 50,
            primary_price: 50,
            secondary_ask: 40,
            price_source: "secondary",
            pack_ev: 80,
            value_ratio: 1.6,
            is_positive_ev: true,
            primary_available: false,
            secondary_available: true,
            ev_snapshotted_at: "2026-09-03T20:00:00.000Z",
          },
        ],
        error: null,
      },
    })
    // Record the filters the route applies to pack_table_rows. The harness
    // builder chains every method silently, so wrap the one this test is about.
    const recorded: Array<[string, ...unknown[]]> = []
    const sb = A.sb as { from: (t: string) => Record<string, unknown> }
    const origFrom = sb.from
    sb.from = (t: string) => {
      const b = origFrom(t)
      if (t === "pack_table_rows") {
        const gte = b.gte as (...a: unknown[]) => unknown
        b.gte = (...a: unknown[]) => { recorded.push(["gte", ...a]); return gte(...a) }
      }
      return b
    }
    const before = Date.now()
    script("compare_pack_value", {})
    await POST(post("best pack to buy?"))
    const r = toolResult()
    expect(r).toMatchObject({ status: "ok" })

    const gte = recorded.find((c) => c[0] === "gte" && c[1] === "ev_snapshotted_at")
    expect(gte, "no ev_snapshotted_at bound was applied to pack_table_rows").toBeDefined()
    const cutoff = Date.parse(String(gte![2]))
    expect(before - cutoff).toBeGreaterThan(71 * 3600 * 1000)
    expect(before - cutoff).toBeLessThan(73 * 3600 * 1000)

    const pack = (r.packs as Array<Record<string, unknown>>)[0]
    expect(pack.ev_as_of).toBe("2026-09-03T20:00:00.000Z")
    expect(String(r.note)).toContain("72 hours")
  })
})

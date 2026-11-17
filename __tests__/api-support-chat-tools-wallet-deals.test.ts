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
    stubFetch([jsonRoute("/api/resolve-topshot-username", { found: false, reason: "username_not_found_on_topshot" })])
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

describe("get_collector_report — index state + All Day leg (2026-10-28)", () => {
  // The report RPC returns an object for ANY wallet, so a never-scanned wallet used to reach the model as ok + zeros.
  const zero = { cross_collection: [], squeeze: { total_moments: null }, rookie_coverage: { owned_count: 0 } }

  it("a never-scanned wallet is not_indexed — no report handed to the model", async () => {
    install({ "rpc:get_wallet_tc_report": { data: zero, error: null }, wallet_backfill_state: { data: [], error: null } })
    script("get_collector_report", { walletAddress: HEX })
    await POST(post("report on my wallet"))
    const r = toolResult()
    expect(r.status).toBe("not_indexed")
    expect(r.report).toBeUndefined()
    expect(String(r.message)).toContain("Do not say the wallet is empty")
  })

  it("every trusted scan found 0 → empty (what our scan found), never a zeroed report", async () => {
    install({
      "rpc:get_wallet_tc_report": { data: zero, error: null },
      wallet_backfill_state: { data: [{ last_scanned_at: "2026-10-28T09:00:00Z", last_found_count: 0 }], error: null },
    })
    script("get_collector_report", { walletAddress: HEX })
    await POST(post("report on my wallet"))
    const r = toolResult()
    expect(r.status).toBe("empty")
    expect(r.report).toBeUndefined()
  })

  it("a failed state read is state_unknown", async () => {
    install({ "rpc:get_wallet_tc_report": { data: zero, error: null }, wallet_backfill_state: { data: null, error: { message: "boom" } } })
    script("get_collector_report", { walletAddress: HEX })
    await POST(post("report on my wallet"))
    expect(toolResult()).toMatchObject({ status: "state_unknown" })
  })

  it("an indexed wallet gets the report plus the All Day squeeze leg", async () => {
    install({
      "rpc:get_wallet_tc_report": { data: { cross_collection: [{ slug: "nfl_all_day", moments: 4 }] }, error: null },
      "rpc:get_allday_wallet_squeeze_exposure": { data: { total_moments: 4, collection: "nfl_all_day" }, error: null },
    })
    script("get_collector_report", { walletAddress: HEX })
    await POST(post("report on my wallet"))
    const r = toolResult()
    expect(r.status).toBe("ok")
    expect((r.allday_squeeze as Record<string, unknown>).total_moments).toBe(4)
    expect(r.allday_squeeze_error).toBe(false)
  })

  it("an indexed wallet's report carries NFL All Day's top sets and acquisitions", async () => {
    install({
      "rpc:get_wallet_tc_report": { data: { cross_collection: [{ slug: "nfl_all_day", moments: 4 }] }, error: null },
      "rpc:get_wallet_allday_tc_sections": { data: { top_sets: [{ set_name: "Rookie Debut", owned_eds: 3 }], recent_acquisitions: [] }, error: null },
    })
    script("get_collector_report", { walletAddress: HEX })
    await POST(post("report on my wallet"))
    const r = toolResult()
    expect(r.status).toBe("ok")
    expect((r.allday_sections as any).top_sets[0].set_name).toBe("Rookie Debut")
    expect(r.allday_sections_error).toBe(false)
  })

  it("a failed All Day sections read is null + flagged — never an empty list", async () => {
    install({
      "rpc:get_wallet_tc_report": { data: { cross_collection: [{ slug: "nfl_all_day", moments: 4 }] }, error: null },
      "rpc:get_wallet_allday_tc_sections": { data: null, error: { message: "boom" } },
    })
    script("get_collector_report", { walletAddress: HEX })
    await POST(post("report on my wallet"))
    const r = toolResult()
    expect(r.status).toBe("ok")
    expect(r.allday_sections).toBeNull()
    expect(r.allday_sections_error).toBe(true)
  })

  it("a failed All Day leg leaves the report standing and says the leg failed", async () => {
    install({
      "rpc:get_wallet_tc_report": { data: { cross_collection: [{ slug: "nba_top_shot", moments: 4 }] }, error: null },
      "rpc:get_allday_wallet_squeeze_exposure": { data: null, error: { message: "boom" } },
    })
    script("get_collector_report", { walletAddress: HEX })
    await POST(post("report on my wallet"))
    const r = toolResult()
    expect(r.status).toBe("ok")
    expect(r.allday_squeeze).toBeNull()
    expect(r.allday_squeeze_error).toBe(true)
  })
})

describe("check_wallet_squeeze", () => {
  // 2026-09-29: the route answers 200 {found:false} for an upstream failure too
  // (reason topshot_gql_error), and a timeout used to fall into the same branch —
  // so an outage told the reader the username had no wallet. Only a genuine miss
  // (username_not_found_on_topshot) may say so.
  it("an upstream lookup failure is reported as a failed lookup, never 'not on file'", async () => {
    install({ "rpc:resolve_topshot_username": { data: { found: false }, error: null } })
    stubFetch([jsonRoute("/api/resolve-topshot-username", { found: false, reason: "topshot_gql_error", detail: "503" })])
    script("check_wallet_squeeze", { walletAddress: "somebody" })
    await POST(post("squeeze for somebody"))
    expect(toolResult()).toMatchObject({ status: "username_lookup_failed", wallet: "somebody" })
    expect(String(toolResult().message)).not.toMatch(/don't have a wallet/)
  })

  it("a lookup that errors outright (non-2xx) is a failed lookup too", async () => {
    install({ "rpc:resolve_topshot_username": { data: { found: false }, error: null } })
    stubFetch([jsonRoute("/api/resolve-topshot-username", { error: "unauthorized" }, { status: 401 })])
    script("analyze_wallet_holdings", { walletAddress: "somebody_else" })
    await POST(post("break down somebody_else"))
    expect(toolResult()).toMatchObject({ status: "username_lookup_failed" })
  })

  it("returns username_not_resolved for an unknown handle", async () => {
    install({ "rpc:resolve_topshot_username": { data: { found: false }, error: null } })
    stubFetch([jsonRoute("/api/resolve-topshot-username", { found: false, reason: "username_not_found_on_topshot" })])
    script("check_wallet_squeeze", { walletAddress: "nobody" })
    await POST(post("squeeze for nobody"))
    expect(toolResult()).toMatchObject({ status: "username_not_resolved" })
  })

  // 2026-10-27: "no moments cached" is TWO answers. A scan that found none is "empty"; a wallet never scanned is
  // "not_indexed" — and must never reach the model as an empty bag (wallet_backfill_state decides).
  it("returns an honest empty (not an error) when a scan found no moments for the wallet", async () => {
    install({
      "rpc:get_wallet_squeeze_exposure": { data: { total_moments: 0 }, error: null },
      wallet_backfill_state: { data: { last_scanned_at: "2026-10-27T17:00:00Z", last_found_count: 0 }, error: null },
    })
    script("check_wallet_squeeze", { walletAddress: HEX })
    await POST(post("squeeze me"))
    expect(toolResult()).toMatchObject({ status: "empty", wallet: HEX, collection: "nba-top-shot" })
  })

  it("a never-scanned wallet is not_indexed, never empty, and points at the page that starts the scan", async () => {
    install({
      "rpc:get_wallet_squeeze_exposure": { data: { total_moments: null }, error: null },
      wallet_backfill_state: { data: null, error: null },
    })
    script("check_wallet_squeeze", { walletAddress: HEX })
    await POST(post("squeeze me"))
    const r = toolResult()
    expect(r.status).toBe("not_indexed")
    expect(r.status).not.toBe("empty")
    expect(String(r.message)).toContain("/insights/squeeze-check?wallet=")
    expect(String(r.message)).toContain("Do not say the wallet is empty")
  })

  it("a failed state read is state_unknown, never empty", async () => {
    install({
      "rpc:get_wallet_squeeze_exposure": { data: { total_moments: null }, error: null },
      wallet_backfill_state: { data: null, error: { message: "boom" } },
    })
    script("check_wallet_squeeze", { walletAddress: HEX })
    await POST(post("squeeze me"))
    expect(toolResult()).toMatchObject({ status: "state_unknown" })
  })

  it("collection nfl-all-day reads the All Day bag", async () => {
    install({
      "rpc:get_allday_wallet_squeeze_exposure": { data: { total_moments: 7, collection: "nfl_all_day" }, error: null },
      "rpc:get_wallet_squeeze_exposure": { data: { total_moments: 999, collection: "nba_top_shot" }, error: null },
    })
    script("check_wallet_squeeze", { walletAddress: HEX, collection: "nfl-all-day" })
    await POST(post("squeeze my all day"))
    const r = toolResult()
    expect(r).toMatchObject({ status: "ok", collection: "nfl-all-day" })
    expect((r.summary as Record<string, unknown>).total_moments).toBe(7)
  })

  it("an unknown collection is refused with no bag — never answered with Top Shot's", async () => {
    install({ "rpc:get_wallet_squeeze_exposure": { data: { total_moments: 999 }, error: null } })
    script("check_wallet_squeeze", { walletAddress: HEX, collection: "laliga-golazos" })
    await POST(post("squeeze my golazos"))
    const r = toolResult()
    expect(r.status).toBe("unsupported_collection")
    expect(r.summary).toBeUndefined()
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
  // ⛔ 2026-10-25: pack_table_rows.pack_ev is EV MINUS the price and value_ratio is
  // gross ÷ the live ask. The tool divided the NET figure by the price, so the live
  // "WNBA Top Shot This: Jonquel Jones" — EV $19.12 at a $12.50 ask, the packs
  // page's 1.53× and is_positive_ev — went to the user as 0.53×, "not +EV".
  // The fixtures below are shaped like the real view: gross_ev, net pack_ev.
  it("the live defect: a pack the packs page marks +EV at the ask is +EV here too", async () => {
    install({
      pack_table_rows: {
        data: [
          {
            collection_slug: "nba-top-shot", collection_name: "NBA Top Shot", title: "WNBA Top Shot This: Jonquel Jones", tier: "fandom",
            retail_price_usd: 10, primary_price: null, secondary_ask: 12.5, price_source: "secondary",
            gross_ev: 19.12, pack_ev: 6.62, value_ratio: 1.53, ev_margin_pct: 53, is_positive_ev: true,
            primary_available: false, secondary_available: true,
          },
        ],
        error: null,
      },
    })
    script("compare_pack_value", {})
    await POST(post("which top shot packs are +EV right now?"))
    const pack = ((toolResult() as { packs: Array<Record<string, unknown>> }).packs)[0]
    expect(pack).toMatchObject({
      current_price: 12.5,
      expected_value_usd: 19.12,
      ev_minus_price_usd: 6.62,
      ev_vs_current_price_ratio: 1.53,
      positive_ev_at_current_price: true,
      packs_page_value_ratio: 1.53,
      packs_page_says_positive_ev: true,
    })
    // The old field that invited "the site's ratio is retail-based" is gone.
    expect(pack).not.toHaveProperty("site_value_ratio_retail_based")
    expect(String((toolResult() as { note?: string }).note)).not.toMatch(/retail-based/)
  })

  it("judges 'worth buying now' by EV against the price the user would PAY, not a stale ratio", async () => {
    // A sold-out pack buyable only at the secondary ask ($100), EV $80 → 0.8, NOT
    // positive, even when the row's value_ratio (1.6, priced against an older basis)
    // looks great. Pins the 2026-07-11 buyable-economics rule on gross EV.
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
            gross_ev: 80,
            pack_ev: 30,
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
      expected_value_usd: 80,
      ev_minus_price_usd: -20,
      ev_vs_current_price_ratio: 0.8,
      positive_ev_at_current_price: false,
      packs_page_value_ratio: 1.6,
    })
  })

  it("ranks by EV ÷ the buyable price, not by the row's value_ratio", async () => {
    install({
      pack_table_rows: {
        data: [
          { collection_slug: "nba-top-shot", title: "A", tier: "common", secondary_ask: 10, price_source: "secondary", gross_ev: 11, pack_ev: 1, value_ratio: 3, primary_available: false, secondary_available: true },
          { collection_slug: "nba-top-shot", title: "B", tier: "common", secondary_ask: 10, price_source: "secondary", gross_ev: 20, pack_ev: 10, value_ratio: 2, primary_available: false, secondary_available: true },
        ],
        error: null,
      },
    })
    script("compare_pack_value", {})
    await POST(post("best pack?"))
    const packs = (toolResult() as { packs: Array<Record<string, unknown>> }).packs
    expect(packs.map((p) => p.pack)).toEqual(["B", "A"])
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
            gross_ev: 400,
            pack_ev: 300,
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

// ── 2026-09-03: a failed chat_sessions read must not become a write ────────────
//
// updateSession read `{ data: existing }` without `error`; a timed-out read
// arrived as undefined and the upsert then wrote conversation_count: 1 and a
// one-topic history over a returning user's real row.
describe("updateSession — a failed chat_sessions read leaves the row untouched", () => {
  it("issues NO chat_sessions upsert when the read errors", async () => {
    const spy = install({
      chat_sessions: { data: null, error: { message: "canceling statement due to statement timeout" } },
    })
    A.state.script = [{ text: "hello there" }]
    A.state.cursor = 0
    const res = await POST(post("hi"))
    expect(res.status).toBe(200)
    // Let the fire-and-forget session update settle.
    await new Promise((r) => setTimeout(r, 50))
    expect(spy.writes.chat_sessions ?? []).toEqual([])
  })
})

// #207 (2026-10-21): concierge_wallet_breakdown and concierge_market_deals ILIKE
// p_player accent-sensitively, so "luka doncic" matched nothing for "Luka Dončić".
// Both now take the resolver's spelling when it names one person with one label.
describe("accent-blind player names reach the ILIKE RPCs in the resolver's spelling (#207)", () => {
  const ONE = { status: "one", query: "luka doncic", query_slug: "luka-doncic", matched_via: "exact", namesakes: [], aliases: [], identity: null, relations: [], matched_query_as: "exact",
    player: { id: "p1", name: "Luka Dončić", slug: "luka-doncic", team: "Los Angeles Lakers", edition_count: 103, labels: ["Luka Dončić"] } }
  const AMBIGUOUS = { status: "ambiguous", query: "luka", query_slug: "luka", candidates: [], note: "two people" }
  const argsOf = (spy: ReturnType<typeof install>, name: string) => spy.rpcCalls.filter((c) => c.name === name).map((c) => c.args)

  it("wallet breakdown: an unaccented name is sent as the resolved spelling", async () => {
    const spy = install({
      "rpc:resolve_player_name": { data: ONE, error: null },
      "rpc:concierge_wallet_breakdown": { data: { total_moments: 3, groups: [] }, error: null },
    })
    script("analyze_wallet_holdings", { walletAddress: HEX, player: "luka doncic" })
    await POST(post("how many doncic moments do I have"))
    expect(argsOf(spy, "concierge_wallet_breakdown").map((a) => a?.p_player)).toEqual(["Luka Dončić"])
  })

  it("wallet breakdown: an ambiguous name keeps the typed text (behaviour unchanged)", async () => {
    const spy = install({
      "rpc:resolve_player_name": { data: AMBIGUOUS, error: null },
      "rpc:concierge_wallet_breakdown": { data: { total_moments: 0, groups: [] }, error: null },
    })
    script("analyze_wallet_holdings", { walletAddress: HEX, player: "luka" })
    await POST(post("my luka moments"))
    expect(argsOf(spy, "concierge_wallet_breakdown").map((a) => a?.p_player)).toEqual(["luka"])
  })

  it("team deals board: the player filter is sent as the resolved spelling", async () => {
    const spy = install({
      "rpc:resolve_player_name": { data: ONE, error: null },
      "rpc:concierge_market_deals": { data: { deals: [] }, error: null },
    })
    script("search_live_deals", { collectionId: "nba-top-shot", team: "Lakers", player: "luka doncic" })
    await POST(post("lakers deals on doncic"))
    expect(argsOf(spy, "concierge_market_deals").map((a) => a?.p_player)).toEqual(["Luka Dončić"])
  })
})

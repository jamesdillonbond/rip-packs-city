import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"
import {
  makeInstrumentedSupabaseFixture,
  installFetchMock,
  jsonRoute,
  type FetchStub,
} from "./helpers/route-harness"
import type { ScriptTurn } from "./helpers/anthropic-fixture"

// Concierge TOOL-ARM coverage, wave 2 — the data-shaping arms the first
// populated file (api-support-chat-tools-populated.test.ts) left dark:
//   - the beta-feedback log helpers' success/offline branches (log_bug /
//     log_feature_request / log_feedback)
//   - search_catalog_deals filter branches (team / maxPrice / minDiscount /
//     hasBadge) + the plain no_results exit
//   - search_serial_deals team/badge post-filter (editions + badge_editions)
//   - search_across_collections cross-collection rollup
//   - the fetch-backed CRUD tools manage_watchlist / manage_alerts
//   - check_wallet's live-walk fallback (wallet not in the indexed cache)
// Same harness + mocks as the sibling file; assertions target the
// handler-COMPUTED tool_result, not a fixture echo.

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
    body: JSON.stringify({ message, sessionId: `pop2-${Math.random()}`, ...extra }),
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

const WALLET = "0xbd94cade097e50ac"
const TS_UUID = "95f28a17-224a-4025-96ad-adf8a4c63bfd"

describe("concierge tools — beta-feedback log helpers", () => {
  it("log_bug returns 'logged' with the row id and echoes the summary", async () => {
    install({ support_conversations: { data: { id: 4242 }, error: null } })
    script("log_bug", { summary: "Sniper feed 500s", details: "Every load throws on /nba-top-shot/sniper" })
    await POST(post("report a bug"))
    const r = toolResult()
    expect(r.status).toBe("logged")
    expect(r.feedback_type).toBe("bug")
    expect(r.summary).toBe("Sniper feed 500s")
  })

  it("log_bug returns 'logged_offline' when the insert yields no id", async () => {
    install({ support_conversations: { data: null, error: null } })
    script("log_bug", { summary: "x", details: "y" })
    await POST(post("bug offline"))
    expect(toolResult().status).toBe("logged_offline")
  })

  it("log_feature_request logs and tags the feature_request type", async () => {
    install({ support_conversations: { data: { id: 7 }, error: null } })
    script("log_feature_request", { summary: "CSV export", details: "Let me export my collection" })
    await POST(post("feature idea"))
    const r = toolResult()
    expect(r.status).toBe("logged")
    expect(r.feedback_type).toBe("feature_request")
  })

  it("log_feedback carries the sentiment and requires both fields", async () => {
    install({ support_conversations: { data: { id: 9 }, error: null } })
    script("log_feedback", { summary: "love it", details: "the FMV data is great", sentiment: "positive" })
    await POST(post("some feedback"))
    const r = toolResult()
    expect(r.status).toBe("logged")
    expect(r.sentiment).toBe("positive")

    A.createCalls.length = 0
    script("log_feedback", { summary: "", details: "" })
    await POST(post("empty feedback"))
    expect(toolResult().status).toBe("error")
  })
})

describe("concierge tools — search_catalog_deals filter branches", () => {
  it("applies team/maxPrice/minDiscount/hasBadge filters and shapes the rows", async () => {
    install({
      cached_listings: {
        data: [
          {
            player_name: "Dame", set_name: "Base", tier: "RARE", serial_number: 3,
            circulation_count: 499, ask_price: 40, fmv: 70, discount: 43,
            badge_slugs: ["rookie"], buy_url: "https://z", collection_id: TS_UUID,
          },
        ],
        error: null,
      },
    })
    script("search_catalog_deals", {
      team: "Trail Blazers", maxPrice: 50, minDiscount: 20, hasBadge: true, tier: "RARE", limit: 8,
    })
    await POST(post("Blazers rookie deals under $50"))
    const r = toolResult()
    expect(r.status).toBe("ok")
    expect(r.total).toBe(1)
    expect((r.results as Array<Record<string, unknown>>)[0]).toMatchObject({ player: "Dame", price: 40, discount_pct: 43 })
  })

  it("returns no_results (no criteria to fall back on) when the catalog is empty", async () => {
    install({ cached_listings: { data: [], error: null } })
    script("search_catalog_deals", { team: "Nobody", limit: 8 })
    await POST(post("deals for nobody"))
    expect(toolResult().status).toBe("no_results")
  })
})

describe("concierge tools — search_serial_deals team/badge post-filter", () => {
  it("keeps only board rows whose edition matches the team filter", async () => {
    install({
      topshot_underpriced_serials_board: {
        data: [
          { player_name: "Dame", set_name: "Base", tier: "RARE", serial_number: 1, circulation_count: 499, ask_usd: 80, serial_fmv_usd: 200, edition_fmv_usd: 150, serial_multiplier: 2, discount_pct: 60, estimate_quality: "tight", confidence: "HIGH", nft_id: "222", edition_key: "3:46", external_id: "3:46" },
          { player_name: "Ant", set_name: "Base", tier: "RARE", serial_number: 5, circulation_count: 99, ask_usd: 10, serial_fmv_usd: 40, edition_fmv_usd: 30, serial_multiplier: 1.3, discount_pct: 50, estimate_quality: "tight", confidence: "HIGH", nft_id: "333", edition_key: "3:47", external_id: "3:47" },
        ],
        error: null,
      },
      // only 3:46 belongs to the Blazers
      editions: { data: [{ external_id: "3:46", team_name: "Portland Trail Blazers" }], error: null },
    })
    script("search_serial_deals", { team: "Blazers", limit: 10 })
    await POST(post("underpriced Blazers special serials"))
    const r = toolResult()
    expect(r.status).toBe("ok")
    const rows = r.rows as Array<Record<string, unknown>>
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ player: "Dame", serial: 1 })
  })

  it("keeps only rows carrying the requested badge tag", async () => {
    install({
      topshot_underpriced_serials_board: {
        data: [
          { player_name: "Dame", set_name: "Base", tier: "RARE", serial_number: 1, circulation_count: 499, ask_usd: 80, serial_fmv_usd: 200, edition_fmv_usd: 150, serial_multiplier: 2, discount_pct: 60, estimate_quality: "tight", confidence: "HIGH", nft_id: "222", edition_key: "3:46", external_id: "3:46" },
        ],
        error: null,
      },
      badge_editions: {
        data: [{ external_id: "3:46", play_tags: [{ title: "Rookie Year" }] }],
        error: null,
      },
    })
    script("search_serial_deals", { badge: "rookie", limit: 10 })
    await POST(post("underpriced rookie special serials"))
    const r = toolResult()
    expect(r.status).toBe("ok")
    expect((r.rows as unknown[]).length).toBe(1)
  })
})

describe("concierge tools — search_across_collections", () => {
  it("rolls up per-collection cached_listings matches for a player name", async () => {
    install({
      cached_listings: {
        data: [
          { player_name: "Dame", set_name: "Base", tier: "RARE", serial_number: 3, ask_price: 40, fmv: 70, discount: 43, buy_url: "https://z" },
        ],
        error: null,
      },
    })
    script("search_across_collections", { name: "Dame", limit: 3 })
    await POST(post("find Dame everywhere"))
    const r = toolResult()
    expect(r.status).toBe("ok")
    // groups is one entry per published collection; total sums their results.
    expect(Array.isArray(r.groups)).toBe(true)
    expect((r.groups as unknown[]).length).toBeGreaterThan(0)
    expect(Number(r.total)).toBeGreaterThan(0)
  })

  it("errors when no name is supplied", async () => {
    install({})
    script("search_across_collections", {})
    await POST(post("find everywhere"))
    expect(toolResult().status).toBe("error")
  })
})

// ctx.userWallet is server-derived (deriveIdentity): sign the session in AND
// resolve the allow_list row to a wallet_addr. The client-passed walletAddress
// is deliberately NOT trusted for these owner-scoped CRUD tools.
function signInWithWallet(fixtures: Fixtures = {}) {
  A.authedEmail = "collector@example.com"
  install({ allow_list: { data: { username: "collector", wallet_addr: WALLET }, error: null }, ...fixtures })
}

describe("concierge tools — manage_watchlist (fetch-backed)", () => {
  it("adds a moment to the watchlist for a signed-in wallet", async () => {
    signInWithWallet()
    stubFetch([jsonRoute("/api/watchlist", { ok: true })])
    script("manage_watchlist", { action: "add", edition_key: "3:46", player_name: "Dame" })
    await POST(post("watch Dame"))
    const r = toolResult()
    expect(r.status).toBe("ok")
    expect(String(r.message)).toContain("Dame")
  })

  it("removes a moment from the watchlist", async () => {
    signInWithWallet()
    stubFetch([jsonRoute("/api/watchlist", { ok: true })])
    script("manage_watchlist", { action: "remove", edition_key: "3:46" })
    await POST(post("unwatch"))
    expect(toolResult().status).toBe("ok")
  })

  it("refuses when there is no owner wallet", async () => {
    script("manage_watchlist", { action: "add", edition_key: "3:46" })
    await POST(post("watch with no wallet"))
    expect(toolResult().status).toBe("error")
  })
})

describe("concierge tools — manage_alerts (fetch-backed)", () => {
  it("lists alerts from the alerts API", async () => {
    signInWithWallet()
    stubFetch([jsonRoute("/api/alerts", { alerts: [{ id: "a1", player_name: "Dame" }] })])
    script("manage_alerts", { action: "list" })
    await POST(post("my alerts"))
    const r = toolResult()
    expect(r.status).toBe("ok")
    expect((r.results as unknown[]).length).toBe(1)
  })

  it("reports the empty state when there are no alerts", async () => {
    signInWithWallet()
    stubFetch([jsonRoute("/api/alerts", { alerts: [] })])
    script("manage_alerts", { action: "list" })
    await POST(post("my alerts"))
    const r = toolResult()
    expect(r.status).toBe("ok")
    expect(r.results).toEqual([])
  })

  it("sets an alert", async () => {
    signInWithWallet()
    stubFetch([jsonRoute("/api/alerts", { ok: true })])
    script("manage_alerts", { action: "set", edition_key: "3:46", player_name: "Dame", alert_type: "price_below", threshold: 50, channel: "email" })
    await POST(post("alert me on Dame"))
    const r = toolResult()
    expect(r.status).toBe("ok")
    expect(String(r.message)).toContain("Dame")
  })

  it("refuses without an owner wallet", async () => {
    script("manage_alerts", { action: "list" })
    await POST(post("alerts no wallet"))
    expect(toolResult().status).toBe("error")
  })
})

describe("concierge tools — check_wallet live-walk fallback", () => {
  it("falls back to /api/wallet-search when the wallet is not in the indexed cache", async () => {
    // Empty snapshot -> not indexed -> the handler walks live via wallet-search.
    install({
      "rpc:get_wallet_collection_snapshot": { data: { totalMoments: 0, totalFmv: 0, perCollection: [], topMoments: [] }, error: null },
      "rpc:get_wallet_best_offer_total": { data: null, error: null },
    })
    stubFetch([
      jsonRoute("/api/wallet-search", {
        moments: [{ player: "Dame", fmv: 120 }, { player: "Ant", fmv: 30 }],
        summary: { totalMoments: 2 },
      }),
    ])
    script("check_wallet", { walletAddress: WALLET })
    await POST(post("what's in this fresh wallet"))
    const r = toolResult()
    expect(r.status).toBe("ok")
    expect(r.wallet).toBe(WALLET)
  })
})

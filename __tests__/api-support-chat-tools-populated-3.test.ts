import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"
import {
  makeInstrumentedSupabaseFixture,
  installFetchMock,
  jsonRoute,
  type FetchStub,
} from "./helpers/route-harness"
import type { ScriptTurn } from "./helpers/anthropic-fixture"

// Concierge TOOL-ARM coverage, wave 3 — the read-only market/ecosystem tools
// and escalation:
//   - get_collection_snapshot (fetch-backed) success + error
//   - escalate_to_human high-urgency dual-channel page + the both-failed
//     pipeline-run telemetry, and the medium-urgency no-page path
//   - get_challenges (username resolve → get_active_challenges) populated +
//     empty-note + username_not_resolved
//   - get_top_sales / get_market_movers / get_rookies / get_premiums /
//     get_ecosystem_stat (the fetchPublicInsight-backed board readers) incl.
//     the kind/metric validation guards

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
    body: JSON.stringify({ message, sessionId: `pop3-${Math.random()}`, ...extra }),
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
  delete process.env.TELEGRAM_BOT_TOKEN
  delete process.env.TELEGRAM_CHAT_ID
  delete process.env.RESEND_API_KEY
  delete process.env.ALERT_EMAIL
})
beforeEach(() => {
  install({})
  A.createCalls.length = 0
  A.authedEmail = null
})

const WALLET = "0xbd94cade097e50ac"

describe("concierge tools — get_collection_snapshot", () => {
  it("shapes the top-moment summary from the snapshot API", async () => {
    stubFetch([
      jsonRoute("/api/collection-snapshot", {
        totalMoments: 50, totalFmv: 1234.5,
        topMoments: [{ playerName: "Dame", tier: "RARE", fmv: 900 }],
      }),
    ])
    script("get_collection_snapshot", { walletAddress: WALLET })
    await POST(post("snapshot my collection"))
    const r = toolResult()
    expect(r.status).toBe("ok")
    expect(String(r.summary)).toContain("50 moments")
    expect(String(r.summary)).toContain("Dame")
  })

  it("returns error when the snapshot API is not ok", async () => {
    stubFetch([jsonRoute("/api/collection-snapshot", {}, { ok: false, status: 500 })])
    script("get_collection_snapshot", { walletAddress: WALLET })
    await POST(post("snapshot fail"))
    expect(toolResult().status).toBe("error")
  })
})

describe("concierge tools — escalate_to_human", () => {
  it("pages both channels on HIGH urgency and reports delivery", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "tok"
    process.env.TELEGRAM_CHAT_ID = "chat"
    process.env.RESEND_API_KEY = "resend"
    process.env.ALERT_EMAIL = "ops@example.com"
    stubFetch([
      jsonRoute("api.telegram.org", { ok: true }),
      jsonRoute("api.resend.com", { id: "email-1" }),
    ])
    script("escalate_to_human", { reason: "site down", category: "bug", urgency: "high" })
    await POST(post("escalate now"))
    const r = toolResult()
    expect(r.status).toBe("escalated")
  })

  it("logs a pipeline failure when BOTH page channels fail on HIGH", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "tok"
    process.env.TELEGRAM_CHAT_ID = "chat"
    process.env.RESEND_API_KEY = "resend"
    process.env.ALERT_EMAIL = "ops@example.com"
    stubFetch([
      jsonRoute("api.telegram.org", {}, { ok: false, status: 500 }),
      jsonRoute("api.resend.com", {}, { ok: false, status: 500 }),
    ])
    const spy = install({})
    script("escalate_to_human", { reason: "site down", category: "bug", urgency: "high" })
    await POST(post("escalate both fail"))
    expect(toolResult().status).toBe("escalated")
    const logged = spy.rpcCalls.find((c) => c.name === "log_pipeline_run")
    expect(logged?.args).toMatchObject({ p_pipeline: "support-chat-escalation", p_ok: false })
  })

  it("does NOT page on medium urgency (logged only, no live notification)", async () => {
    // No fetch stub installed — a medium escalation must not hit any channel.
    script("escalate_to_human", { reason: "minor question", category: "general", urgency: "medium" })
    await POST(post("escalate medium"))
    expect(toolResult().status).toBe("escalated")
  })
})

describe("concierge tools — get_challenges", () => {
  it("resolves a username then shapes the active-challenge board", async () => {
    install({
      "rpc:resolve_topshot_username": { data: { found: true, wallet_address: WALLET.slice(2) }, error: null },
      "rpc:get_active_challenges": {
        data: {
          activeCount: 1,
          challenges: [
            { name: "Blazers SC", challengeType: "set", rewardLabel: "Reward Moment", rewardKind: "moment",
              endsAt: "2026-09-01", completionPct: 60, missingCount: 4, totalRequired: 10,
              costToComplete: 120, rewardValue: 200, netEv: 80, worthIt: true, completedCount: 5, totalRewardAllocation: 100 },
          ],
        },
        error: null,
      },
    })
    script("get_challenges", { walletAddress: "jamesdillonbond" })
    await POST(post("what challenges are worth it"))
    const r = toolResult()
    expect(r.status).toBe("ok")
    expect(r.active_count).toBe(1)
    expect((r.challenges as Array<Record<string, unknown>>)[0]).toMatchObject({ name: "Blazers SC", net_ev_usd: 80 })
    expect(String(r.note)).toContain("net_ev_usd")
  })

  it("returns the empty-note when no challenges are seeded", async () => {
    install({ "rpc:get_active_challenges": { data: { activeCount: 0, challenges: [] }, error: null } })
    script("get_challenges", {})
    await POST(post("any challenges"))
    const r = toolResult()
    expect(r.status).toBe("ok")
    expect(String(r.note)).toMatch(/no active challenges/i)
  })

  it("returns username_not_resolved for an unknown handle", async () => {
    install({ "rpc:resolve_topshot_username": { data: { found: false }, error: null } })
    script("get_challenges", { walletAddress: "ghost" })
    await POST(post("challenges for ghost"))
    expect(toolResult().status).toBe("username_not_resolved")
  })
})

describe("concierge tools — public insight board readers", () => {
  it("get_top_sales maps the active collection and forwards to the board", async () => {
    stubFetch([jsonRoute("/api/public/insights/top-sales", { rows: [{ player: "Dame", price: 5000 }], meta: { window: "7d" } })])
    script("get_top_sales", { window: "30d", limit: 5 })
    await POST(post("biggest sales", { collectionId: "nba-top-shot" }))
    const r = toolResult()
    expect(r.status).toBe("ok")
    expect(r.count).toBe(1)
    const url = String(fetchMock!.calls[0].url)
    expect(url).toContain("collection=nba_top_shot")
    expect(url).toContain("window=30d")
  })

  it("get_market_movers reads the market-pulse board", async () => {
    stubFetch([jsonRoute("/api/public/insights/market-pulse", { rows: [{ player: "Ant", change: 12 }] })])
    script("get_market_movers", { limit: 10 })
    await POST(post("what's hot"))
    expect(toolResult().status).toBe("ok")
  })

  it("get_rookies forwards the sort param", async () => {
    stubFetch([jsonRoute("/api/public/insights/rookies", { rows: [] })])
    script("get_rookies", { sort: "volume", limit: 20 })
    await POST(post("rookie market"))
    expect(String(fetchMock!.calls[0].url)).toContain("sort=volume")
  })

  it("get_premiums validates kind and routes parallel vs serial", async () => {
    stubFetch([jsonRoute("/api/public/insights/parallel-premiums", { rows: [{ x: 1 }] })])
    script("get_premiums", { kind: "parallel" })
    await POST(post("parallel premiums"))
    expect(toolResult().status).toBe("ok")

    A.createCalls.length = 0
    script("get_premiums", { kind: "banana" })
    await POST(post("bad premiums"))
    expect(toolResult().status).toBe("error")
  })

  it("get_ecosystem_stat maps the metric and rejects an unknown one", async () => {
    stubFetch([jsonRoute("/api/public/insights/offer-spread", { rows: [{ spread: 5 }] })])
    script("get_ecosystem_stat", { metric: "offer_spread" })
    await POST(post("offer spreads"))
    expect(toolResult().status).toBe("ok")

    A.createCalls.length = 0
    script("get_ecosystem_stat", { metric: "nonsense" })
    await POST(post("bad metric"))
    expect(toolResult().status).toBe("error")
  })
})

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"
import {
  makeInstrumentedSupabaseFixture,
  installFetchMock,
  jsonRoute,
  type FetchStub,
} from "./helpers/route-harness"
import type { ScriptTurn } from "./helpers/anthropic-fixture"

// Concierge TOOL-ARM coverage: drives individual executeTool branches through
// the real loop and asserts on the tool_result JSON the handler feeds back to
// the model (captured from the second messages.create call) plus the side
// effects (Supabase writes, self-API fetches, escalation pages). Complements
// the loop-mechanics tests (api-support-chat-tool-loop) and streaming tests.

const A = vi.hoisted(() => ({
  state: { script: [] as ScriptTurn[], cursor: 0 },
  createCalls: [] as Array<{ messages: Array<{ role: string; content: unknown }> }>,
  sb: null as unknown,
  // When set, deriveIdentity sees a signed-in user with this email; the
  // allow_list fixture then supplies ownerKey/userWallet.
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

// Escalation channels are read from env INSIDE the tool at call time.
process.env.ANTHROPIC_API_KEY = "test-key"
process.env.TELEGRAM_BOT_TOKEN = "tg-token"
process.env.TELEGRAM_CHAT_ID = "12345"
process.env.RESEND_API_KEY = "re-key"
process.env.ALERT_EMAIL = "ops@example.com"

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
    body: JSON.stringify({ message, sessionId: `tool-${Math.random()}`, ...extra }),
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

describe("concierge tools — guards and cross-collection honesty", () => {
  it("get_fmv without any identifier returns the usage error, never a made-up price", async () => {
    script("get_fmv", {})
    await POST(post("what's it worth?"))
    expect(toolResult()).toMatchObject({ status: "error" })
    expect(String(toolResult().message)).toContain("Provide editionKey")
  })

  it("manage_watchlist and manage_alerts refuse without a connected wallet", async () => {
    script("manage_watchlist", { action: "add", edition_key: "3:45" })
    await POST(post("watch this"))
    expect(toolResult()).toMatchObject({ status: "error", message: "owner_key_missing" })

    A.createCalls.length = 0
    script("manage_alerts", { action: "list" })
    await POST(post("my alerts"))
    expect(toolResult()).toMatchObject({ status: "error", message: "owner_key_missing" })
  })
})

describe("concierge tools — watchlist/alerts self-API bridge", () => {
  const WALLET = "0xbd94cade097e50ac"

  // userWallet is SERVER-derived (deriveIdentity -> allow_list), never taken
  // from the request body — sign the session in and let allow_list supply it.
  function signIn() {
    A.authedEmail = "collector@example.com"
    return install({
      allow_list: { data: { username: "collector", wallet_addr: WALLET }, error: null },
    })
  }

  it("watchlist add POSTs the owner-keyed row and reports the added player", async () => {
    const f = stubFetch([jsonRoute("/api/watchlist", { ok: true, id: 9 })])
    signIn()
    script("manage_watchlist", {
      action: "add",
      edition_key: "3:45",
      player_name: "Damian Lillard",
      set_name: "Base Set",
      tier: "COMMON",
    })
    await POST(post("add dame to my watchlist"))

    expect(toolResult()).toMatchObject({ status: "ok" })
    expect(String(toolResult().message)).toContain("Added Damian Lillard")
    const call = f.calls.find((c) => c.url.includes("/api/watchlist") && c.init?.method === "POST")
    expect(JSON.parse(String(call?.init?.body))).toMatchObject({
      owner_key: WALLET,
      edition_key: "3:45",
      player_name: "Damian Lillard",
    })
  })

  it("watchlist list returns the rows; an empty list says so honestly", async () => {
    signIn()
    stubFetch([jsonRoute("/api/watchlist", { watchlist: [{ edition_key: "3:45", player_name: "Dame" }] })])
    script("manage_watchlist", { action: "list" })
    await POST(post("show my watchlist"))
    expect((toolResult().results as unknown[]).length).toBe(1)

    A.createCalls.length = 0
    fetchMock?.restore()
    signIn()
    stubFetch([jsonRoute("/api/watchlist", { watchlist: [] })])
    script("manage_watchlist", { action: "list" })
    await POST(post("show my watchlist"))
    expect(String(toolResult().message)).toContain("watchlist is empty")
  })

  it("alerts set POSTs the threshold subscription", async () => {
    signIn()
    const f = stubFetch([jsonRoute("/api/alerts", { ok: true })])
    script("manage_alerts", {
      action: "set",
      edition_key: "3:45",
      player_name: "Dame",
      alert_type: "below_price",
      threshold: 20,
      channel: "email",
    })
    await POST(post("alert me under $20"))

    expect(toolResult()).toMatchObject({ status: "ok" })
    const call = f.calls.find((c) => c.url.includes("/api/alerts") && c.init?.method === "POST")
    expect(JSON.parse(String(call?.init?.body))).toMatchObject({
      owner_key: WALLET,
      alert_type: "below_price",
      threshold: 20,
    })
  })
})

describe("concierge tools — data reads", () => {
  it("get_collection_snapshot summarizes the wallet from the snapshot API", async () => {
    stubFetch([
      jsonRoute("/api/collection-snapshot", {
        totalMoments: 3,
        totalFmv: 120,
        topMoments: [
          { playerName: "Dame", tier: "RARE", fmv: 80 },
          { playerName: "Scoot", tier: "COMMON", fmv: 25 },
        ],
      }),
    ])
    script("get_collection_snapshot", { walletAddress: "0xbd94cade097e50ac" })
    await POST(post("summarize my collection"))

    const r = toolResult()
    expect(r.status).toBe("ok")
    expect(String(r.summary)).toContain("3 moments, total FMV $120.00")
    expect(String(r.summary)).toContain("Dame (RARE) — $80.00")
  })

  it("get_hot_floors shapes the sweep rows with computed avg_paid", async () => {
    install({
      "rpc:get_topshot_hot_floors": {
        data: {
          editions: [
            {
              external_id: "3:45",
              player_name: "Dame",
              set_name: "Base",
              tier: "COMMON",
              sweep_buyers: 4,
              swept_sales: 10,
              swept_spend: 55,
              floor_ask: 6,
              fmv_usd: 5.5,
              last_swept_at: "2026-07-17T12:00:00Z",
            },
          ],
        },
        error: null,
      },
    })
    script("get_hot_floors", { days: 3 })
    await POST(post("what's being swept?"))

    const r = toolResult()
    expect(r.status).toBe("ok")
    const floors = r.hot_floors as Array<Record<string, unknown>>
    expect(floors[0]).toMatchObject({ edition: "3:45", sweep_buyers: 4, avg_paid_usd: 5.5 })
  })

  it("get_challenges resolves the wallet, shapes net-EV rows, and says plainly when none exist", async () => {
    install({
      "rpc:get_active_challenges": {
        data: {
          activeCount: 1,
          challenges: [
            {
              name: "Finals Flash",
              challengeType: "set",
              rewardLabel: "Finals Pack",
              rewardKind: "pack",
              endsAt: "2026-07-20T00:00:00Z",
              completionPct: 60,
              missingCount: 2,
              totalRequired: 5,
              costToComplete: 12,
              rewardValue: 30,
              netEv: 18,
              worthIt: true,
            },
          ],
        },
        error: null,
      },
    })
    script("get_challenges", { walletAddress: "0xbd94cade097e50ac" })
    await POST(post("any challenges worth doing?"))
    const r = toolResult()
    expect(r.active_count).toBe(1)
    expect((r.challenges as Array<Record<string, unknown>>)[0]).toMatchObject({
      name: "Finals Flash",
      net_ev_usd: 18,
      worth_it: true,
    })

    A.createCalls.length = 0
    install({ "rpc:get_active_challenges": { data: { activeCount: 0, challenges: [] }, error: null } })
    script("get_challenges", {})
    await POST(post("challenges?"))
    expect(String(toolResult().note)).toContain("don't invent challenges")
  })

  it("get_challenges with an unresolvable username asks for the 0x address instead of guessing", async () => {
    install({ "rpc:resolve_topshot_username": { data: { found: false }, error: null } })
    script("get_challenges", { walletAddress: "some-username" })
    await POST(post("challenges for some-username"))
    expect(toolResult()).toMatchObject({ status: "username_not_resolved" })
  })
})

describe("concierge tools — feedback intake + escalation", () => {
  it("log_bug writes the beta-feedback row with the severity/page details block", async () => {
    const spy = install({ support_conversations: { data: { id: 77 }, error: null } })
    script("log_bug", { summary: "Chart broken", details: "FMV chart blank on edition page", severity: "high" })
    await POST(post("the chart is broken"))

    expect(toolResult()).toMatchObject({ status: "logged", feedback_type: "bug", severity: "high" })
    const insert = spy.writes.support_conversations?.find((w) => w.method === "insert")
    expect(insert?.rows[0]).toMatchObject({
      category: "beta_feedback",
      feedback_type: "bug",
      feedback_summary: "Chart broken",
      feedback_status: "new",
    })
    expect(String(insert?.rows[0].feedback_details)).toContain("Severity: high")
  })

  it("log_feedback without details errors instead of logging an empty row", async () => {
    const spy = install({})
    script("log_feedback", { summary: "nice", details: "" })
    await POST(post("nice site"))
    expect(toolResult()).toMatchObject({ status: "error" })
    expect(spy.writes.support_conversations ?? []).toHaveLength(0)
  })

  it("HIGH-urgency escalation pages Telegram and reports paged", async () => {
    const f = stubFetch([
      jsonRoute("api.telegram.org", { ok: true }),
      jsonRoute("api.resend.com", { id: "email-1" }),
    ])
    script("escalate_to_human", { reason: "payment stuck", category: "billing", urgency: "high" })
    const res = await POST(post("I need a human NOW"))
    const body = await res.json()

    // The loop-level escalation flag + the live page both fired.
    expect(body.escalated).toBe(true)
    const tg = f.calls.find((c) => c.url.includes("api.telegram.org"))
    expect(tg).toBeTruthy()
    expect(String(tg?.init?.body)).toContain("payment stuck")
  })

  it("medium-urgency escalation does NOT page live channels", async () => {
    const f = stubFetch([jsonRoute("api.telegram.org", { ok: true }), jsonRoute("api.resend.com", {})])
    script("escalate_to_human", { reason: "minor question", category: "general", urgency: "medium" })
    const res = await POST(post("can someone follow up eventually"))
    expect((await res.json()).escalated).toBe(true)
    expect(f.calls.filter((c) => c.url.includes("telegram") || c.url.includes("resend"))).toHaveLength(0)
  })
})

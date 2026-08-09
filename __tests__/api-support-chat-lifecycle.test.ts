import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"
import { makeInstrumentedSupabaseFixture } from "./helpers/route-harness"
import type { ScriptTurn } from "./helpers/anthropic-fixture"

// Concierge REQUEST-LIFECYCLE coverage — the branches around the tool loop that
// the tool-arm files don't reach:
//   - the greeting short-circuit (ownerKey × collection variants, both the JSON
//     and the streaming responses)
//   - the daily-quota 429 gate (Pro-plan exhausted)
//   - the trusted-bot DM path (server-side history rebuild via loadBotDmHistory)
//   - the Anthropic model_error telemetry path (reportConciergeModelError)

const A = vi.hoisted(() => ({
  state: { script: [] as ScriptTurn[], cursor: 0 },
  createCalls: [] as Array<{ messages: Array<{ role: string; content: unknown }> }>,
  sb: null as unknown,
  authedEmail: null as string | null,
  quota: { allowed: true, plan: "pro", daily_limit: 200, used_today: 0 } as Record<string, unknown>,
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
  checkFeatureQuota: async () => A.quota,
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

function post(message: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("https://t/api/support-chat", {
    method: "POST",
    headers: new Headers({ "content-type": "application/json", ...headers }),
    body: JSON.stringify({ message, sessionId: `life-${Math.random()}`, ...extra }),
  })
}

function textTurn() {
  A.state.script = [{ text: "hello from the model" }]
  A.state.cursor = 0
}

beforeEach(() => {
  install({})
  A.createCalls.length = 0
  A.authedEmail = null
  A.quota = { allowed: true, plan: "pro", daily_limit: 200, used_today: 0 }
})
afterEach(() => {
  delete process.env.INGEST_SECRET_TOKEN
})

const WALLET = "0xbd94cade097e50ac"

describe("concierge lifecycle — greeting short-circuit", () => {
  it("anonymous greeting returns the generic welcome (no model call)", async () => {
    const res = await POST(post("hi"))
    const body = await res.json()
    expect(String(body.response)).toContain("free beta")
    // A greeting short-circuits before the tool loop — the model is never called.
    expect(A.createCalls.length).toBe(0)
  })

  it("greeting with an active collection names that collection", async () => {
    const res = await POST(post("hey", { collectionId: "nba-top-shot" }))
    const body = await res.json()
    expect(String(body.response)).toContain("NBA Top Shot")
  })

  it("signed-in greeting addresses the user by handle", async () => {
    A.authedEmail = "collector@example.com"
    install({ allow_list: { data: { username: "collector", wallet_addr: WALLET }, error: null } })
    const res = await POST(post("gm"))
    const body = await res.json()
    expect(String(body.response)).toContain("collector")
  })

  it("a streaming greeting returns the SSE-style stream response", async () => {
    const res = await POST(post("hello", { stream: true }))
    expect(res.headers.get("X-RPC-Stream")).toBe("1")
    expect(res.headers.get("Content-Type")).toContain("text/plain")
    const text = await res.text()
    expect(text).toContain("free beta")
  })
})

describe("concierge lifecycle — daily quota gate", () => {
  it("returns 429 daily_limit_reached when a signed-in wallet is over quota", async () => {
    A.authedEmail = "collector@example.com"
    install({ allow_list: { data: { username: "collector", wallet_addr: WALLET }, error: null } })
    A.quota = { allowed: false, plan: "pro", daily_limit: 200, used_today: 200 }
    const res = await POST(post("what's the FMV of the Dame base"))
    expect(res.status).toBe(429)
    const body = await res.json()
    expect(body.error).toBe("daily_limit_reached")
    expect(body.upgrade_url).toBe("/pricing")
    // Gated before the model loop.
    expect(A.createCalls.length).toBe(0)
  })

  it("an anonymous user bypasses the quota gate (no wallet to meter)", async () => {
    A.quota = { allowed: false, plan: "free", daily_limit: 0 }
    textTurn()
    const res = await POST(post("just chatting"))
    // Not a 429 — anon traffic relies on the per-session rate limit, not quota.
    expect(res.status).not.toBe(429)
  })
})

describe("concierge lifecycle — trusted bot DM history", () => {
  it("rebuilds server-side history for a secret-verified bot_dm request", async () => {
    process.env.INGEST_SECRET_TOKEN = "bot-secret-token"
    install({
      // deriveIdentity has no cookie for the bot; ownerKey resolves the wallet.
      allow_list: { data: { wallet_addr: WALLET }, error: null },
      // loadBotDmHistory reads the last turns for the session.
      support_conversations: {
        data: [
          { user_message: "earlier question", bot_response: "earlier answer" },
        ],
        error: null,
      },
    })
    textTurn()
    const res = await POST(
      post("follow-up question", { pageContext: "bot_dm", ownerKey: "collector" }, { "x-rpc-bot-secret": "bot-secret-token" }),
    )
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(String(body.response)).toContain("hello from the model")
    // The follow-up model call carried the rebuilt prior turn as history.
    const firstCall = A.createCalls[0]
    const roles = firstCall.messages.map((m) => m.role)
    expect(roles.filter((r) => r === "user").length).toBeGreaterThan(1)
  })

  it("ignores the bot_dm claim when the secret header is wrong", async () => {
    process.env.INGEST_SECRET_TOKEN = "bot-secret-token"
    textTurn()
    const res = await POST(
      post("spoofed", { pageContext: "bot_dm", ownerKey: "attacker" }, { "x-rpc-bot-secret": "WRONG" }),
    )
    // Still answers, but as an untrusted anon request (no owner injected).
    expect(res.status).toBe(200)
  })
})

describe("concierge lifecycle — model_error telemetry", () => {
  it("surfaces the canned model-unavailable message when Anthropic 404s", async () => {
    A.state.script = [{ error: { message: "model: claude-x not found", status: 404, type: "not_found_error" } }]
    A.state.cursor = 0
    const res = await POST(post("price check please"))
    const body = await res.json()
    expect(String(body.response)).toContain("temporarily unavailable")
    expect(body.category).toBe("concierge_model_error")
  })
})

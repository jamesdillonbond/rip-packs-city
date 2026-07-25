import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"
import {
  makeInstrumentedSupabaseFixture,
  installFetchMock,
  jsonRoute,
  type FetchStub,
} from "./helpers/route-harness"
import type { ScriptTurn } from "./helpers/anthropic-fixture"

// Extends api-support-chat-tools.test.ts to the concierge tool arms that file did
// NOT cover — driving each executeTool branch through the real tool-use loop and
// asserting on the tool_result JSON handed back to the model. Focus on the input
// guards (the honesty-critical "never invent an answer" returns) plus a few
// success/dispatch paths that only need a light Supabase fixture.

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
  createClient: () => new Proxy({}, { get: (_t, prop) => (A.sb as Record<PropertyKey, unknown>)[prop] }),
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
process.env.INGEST_SECRET_TOKEN = "ingest"

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
    body: JSON.stringify({ message, sessionId: `tx-${Math.random()}`, ...extra }),
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
function stubFetch(stubs: FetchStub[]) { fetchMock = installFetchMock(stubs); return fetchMock }
afterEach(() => { fetchMock?.restore(); fetchMock = null })
beforeEach(() => { install({}); A.createCalls.length = 0; A.authedEmail = null })

describe("concierge tools (extra) — input guards", () => {
  it("log_feature_request without summary/details returns the usage error", async () => {
    script("log_feature_request", { summary: "add dark mode" }) // no details
    await POST(post("feature idea"))
    expect(toolResult()).toMatchObject({ status: "error" })
    expect(String(toolResult().message)).toContain("required")
  })

  it("search_across_collections without a name refuses", async () => {
    script("search_across_collections", {})
    await POST(post("search everywhere"))
    expect(toolResult()).toMatchObject({ status: "error", message: "name required" })
  })

  it("explain_fmv without an editionKey refuses", async () => {
    script("explain_fmv", {})
    await POST(post("why is it worth that"))
    expect(toolResult()).toMatchObject({ status: "error", message: "editionKey is required" })
  })

  it("get_edition_sweep rejects a non setID:playID key", async () => {
    script("get_edition_sweep", { editionKey: "not-a-key" })
    await POST(post("sweep?"))
    expect(toolResult()).toMatchObject({ status: "error" })
    expect(String(toolResult().message)).toContain("setID:playID")
  })

  it("get_set_completion_cost without a setName refuses", async () => {
    script("get_set_completion_cost", {})
    await POST(post("cost to finish"))
    expect(toolResult()).toMatchObject({ status: "error", message: "setName is required." })
  })

  it("manage_deal_subscriptions with no session is not_linked", async () => {
    script("manage_deal_subscriptions", { action: "list" })
    await POST(post("my deal alerts"))
    expect(toolResult()).toMatchObject({ status: "not_linked" })
  })
})

describe("concierge tools (extra) — dispatch + light success/branch paths", () => {
  it("get_edition_sweep: unknown edition → not_found", async () => {
    install({ editions: { data: null, error: null } }) // maybeSingle → no row
    script("get_edition_sweep", { editionKey: "258:8912" })
    await POST(post("sweep on 258:8912"))
    expect(toolResult()).toMatchObject({ status: "not_found", editionKey: "258:8912" })
  })

  it("get_edition_sweep: edition found → ok with the sweep signal merged", async () => {
    install({
      editions: { data: { id: "ED1" }, error: null },
      "rpc:get_edition_sweep_signal": { data: { quick_buy_sales: 5, swept_sales: 2, swept_share: 0.4 }, error: null },
    })
    script("get_edition_sweep", { editionKey: "258:8912", days: 14 })
    await POST(post("sweep on 258:8912"))
    const r = toolResult()
    expect(r.status).toBe("ok")
    expect(r.editionKey).toBe("258:8912")
    expect(r.quick_buy_sales).toBe(5)
  })

  it("get_set_completion_cost: no set match → set_not_found", async () => {
    install({ sets: { data: [], error: null } })
    script("get_set_completion_cost", { setName: "Nonexistent Set" })
    await POST(post("finish this set"))
    expect(toolResult()).toMatchObject({ status: "set_not_found" })
  })

  it("get_set_completion_cost: multiple set matches → ambiguous_set with candidates", async () => {
    install({ sets: { data: [{ id: "s1", name: "Base 1", series: 1 }, { id: "s2", name: "Base 2", series: 2 }], error: null } })
    script("get_set_completion_cost", { setName: "Base" })
    await POST(post("finish base"))
    const r = toolResult()
    expect(r.status).toBe("ambiguous_set")
    expect((r.candidates as unknown[]).length).toBe(2)
  })

  it("get_special_serial_owners: an rpc error surfaces as status error (never a fabricated owner)", async () => {
    install({ "rpc:get_special_serial_owners_board": { data: null, error: { message: "board rpc down" } } })
    script("get_special_serial_owners", { playerName: "LeBron James" })
    await POST(post("who owns the #1s"))
    expect(toolResult()).toMatchObject({ status: "error", message: "board rpc down" })
  })

  it("check_wallet: an unresolvable username returns a graceful unresolved message, not a lie", async () => {
    install({ "rpc:resolve_topshot_username": { data: { found: false }, error: null } })
    stubFetch([jsonRoute("/api/resolve-topshot-username", { found: false })])
    script("check_wallet", { walletAddress: "ghostuser" })
    await POST(post("check ghostuser"))
    const r = toolResult()
    // the handler returns a non-ok status (username unresolved) rather than inventing a wallet
    expect(r.status).not.toBe("ok")
    expect(JSON.stringify(r).toLowerCase()).toContain("username")
  })
})

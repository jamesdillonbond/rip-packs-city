import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"
import { makeInstrumentedSupabaseFixture, installFetchMock, jsonRoute, type FetchStub } from "./helpers/route-harness"
import type { ScriptTurn } from "./helpers/anthropic-fixture"

// Concierge coverage for the 2026-07-20 read-only market/ecosystem tools
// (get_top_sales / get_market_movers / get_rookies / get_premiums /
// get_ecosystem_stat / get_insight_board) and their shared fetchPublicInsight
// helper — the enum→path maps, param plumbing, and the helper's rows/meta/
// non-row/non-200/json-error branches, all previously dark. Same harness as
// api-support-chat-tools.test.ts.

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

const { POST } = await import("@/app/api/support-chat/route")

type Fixtures = Parameters<typeof makeInstrumentedSupabaseFixture>[0]
function install(fixtures: Fixtures) {
  A.sb = makeInstrumentedSupabaseFixture(fixtures).fixture
}
function post(message: string, extra: Record<string, unknown> = {}): NextRequest {
  return new NextRequest("https://t/api/support-chat", {
    method: "POST",
    headers: new Headers({ "content-type": "application/json" }),
    body: JSON.stringify({ message, sessionId: `eco-${Math.random()}`, ...extra }),
  })
}
function script(toolName: string, input: unknown) {
  A.state.script = [{ tools: [{ name: toolName, input }] }, { text: "done" }]
  A.state.cursor = 0
}
function toolResult(): Record<string, unknown> {
  const secondCall = A.createCalls.at(-1)
  const blocks = secondCall?.messages.at(-1)?.content as Array<{ type: string; content: string }>
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

async function drive(tool: string, input: unknown, stubs: FetchStub[] = []) {
  if (stubs.length) stubFetch(stubs)
  script(tool, input)
  await POST(post("ecosystem query"))
  return toolResult()
}

describe("concierge — get_top_sales", () => {
  it("maps the app collection slug + window + clamps limit into the top-sales board query", async () => {
    const f = stubFetch([jsonRoute("/api/public/insights/top-sales", { rows: [{ id: 1 }, { id: 2 }], meta: { window: "30d" } })])
    script("get_top_sales", { collectionId: "nba-top-shot", window: "30d", limit: 2 })
    await POST(post("top sales"))
    const r = toolResult()
    expect(r).toMatchObject({ status: "ok", count: 2 })
    expect(r.meta).toMatchObject({ window: "30d" })
    const url = f.calls.find((c) => c.url.includes("/top-sales"))!.url
    expect(url).toContain("collection=nba_top_shot")
    expect(url).toContain("window=30d")
    expect(url).toContain("limit=2")
  })

  it("defaults to a 7d window and omits collection when none is in context", async () => {
    const f = stubFetch([jsonRoute("/api/public/insights/top-sales", { rows: [] })])
    script("get_top_sales", {})
    await POST(post("top sales"))
    const url = f.calls.find((c) => c.url.includes("/top-sales"))!.url
    expect(url).toContain("window=7d")
    expect(url).not.toContain("collection=")
  })
})

describe("concierge — market-pulse / rookies", () => {
  it("get_market_movers reads the market-pulse board", async () => {
    const r = await drive("get_market_movers", { limit: 5 }, [jsonRoute("/api/public/insights/market-pulse", { rows: [{ m: 1 }] })])
    expect(r).toMatchObject({ status: "ok", count: 1 })
  })
  it("get_rookies forwards the sort param", async () => {
    const f = stubFetch([jsonRoute("/api/public/insights/rookies", { rows: [] })])
    script("get_rookies", { sort: "mint_desc", limit: 3 })
    await POST(post("rookies"))
    expect(f.calls.find((c) => c.url.includes("/rookies"))!.url).toContain("sort=mint_desc")
  })
})

describe("concierge — get_premiums enum dispatch", () => {
  it.each([
    ["serial", "serial-premiums"],
    ["parallel", "parallel-premiums"],
  ])("routes kind=%s to the %s board", async (kind, path) => {
    const f = stubFetch([jsonRoute(`/api/public/insights/${path}`, { rows: [{ x: 1 }] })])
    script("get_premiums", { kind, limit: 10 })
    await POST(post("premiums"))
    expect(f.calls.some((c) => c.url.includes(`/${path}`))).toBe(true)
    expect(toolResult()).toMatchObject({ status: "ok" })
  })
  it("rejects an unknown kind without fetching", async () => {
    const r = await drive("get_premiums", { kind: "bogus" })
    expect(r).toMatchObject({ status: "error" })
    expect(String(r.message)).toContain("parallel")
  })
})

describe("concierge — get_ecosystem_stat + get_insight_board enum maps", () => {
  it("maps a valid ecosystem metric to its board path", async () => {
    const f = stubFetch([jsonRoute("/api/public/insights/new-collectors", { rows: [{ w: "0x1" }] })])
    script("get_ecosystem_stat", { metric: "new_collectors" })
    await POST(post("who's new"))
    expect(f.calls.some((c) => c.url.includes("/new-collectors"))).toBe(true)
    expect(toolResult()).toMatchObject({ status: "ok", count: 1 })
  })
  it("rejects an unknown ecosystem metric", async () => {
    expect(await drive("get_ecosystem_stat", { metric: "nope" })).toMatchObject({ status: "error" })
  })
  it("maps a valid insight board enum to its path", async () => {
    const f = stubFetch([jsonRoute("/api/public/insights/set-completers", { rows: [{ s: 1 }] })])
    script("get_insight_board", { board: "set_completers" })
    await POST(post("set completers"))
    expect(f.calls.some((c) => c.url.includes("/set-completers"))).toBe(true)
  })
  it("rejects an unknown insight board and lists the valid ones", async () => {
    const r = await drive("get_insight_board", { board: "nonsense" })
    expect(r).toMatchObject({ status: "error" })
    expect(String(r.message)).toContain("squeeze")
  })
})

describe("concierge — fetchPublicInsight response shapes", () => {
  it("passes a non-row payload through under data", async () => {
    const r = await drive("get_market_movers", {}, [jsonRoute("/api/public/insights/market-pulse", { headline: "hot", stats: { n: 3 } })])
    expect(r).toMatchObject({ status: "ok", headline: "hot" })
    expect(r.stats).toMatchObject({ n: 3 })
  })
  it("reports a non-200 board as a status error carrying the http status", async () => {
    const r = await drive("get_market_movers", {}, [jsonRoute("/api/public/insights/market-pulse", {}, { status: 503, ok: false })])
    expect(r).toMatchObject({ status: "error", http_status: 503 })
  })
  it("surfaces a board-level error field as a status error", async () => {
    const r = await drive("get_market_movers", {}, [jsonRoute("/api/public/insights/market-pulse", { error: "board disabled" })])
    expect(r).toMatchObject({ status: "error", message: "board disabled" })
  })
})

// 2026-09-25 — asked which Top Shot challenges a wallet was closest to finishing,
// the concierge said "Top Shot likely hasn't launched any eligible challenges".
// RPC's challenge tracker is empty because its INGEST has failed since
// 2026-08-29 (every one of the 31 seeded challenges ended by 07-15) — an empty
// tracker says nothing about Top Shot. get_challenges now reads the same feed-
// freshness state the /challenges page does and words the empty case from it.

import { describe, it, expect, beforeEach, vi } from "vitest"
import { NextRequest } from "next/server"
import { makeInstrumentedSupabaseFixture } from "./helpers/route-harness"
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
    body: JSON.stringify({ message: "which challenges am I close to?", sessionId: `c-${Math.random()}`, collectionId: "nba-top-shot" }),
  })
}
function toolResult(): Record<string, any> {
  const blocks = A.createCalls.at(-1)?.messages.at(-1)?.content as Array<{ type: string; content: string }>
  const tr = blocks?.find((b) => b.type === "tool_result")
  if (!tr) throw new Error("no tool_result")
  return JSON.parse(tr.content)
}
const empty = { "rpc:get_active_challenges": { data: { activeCount: 0, challenges: [] }, error: null } }

beforeEach(() => {
  A.createCalls.length = 0
  A.state.script = [{ tools: [{ name: "get_challenges", input: { walletAddress: "0xbd94cade097e50ac" } }] }, { text: "done" }]
  A.state.cursor = 0
})

describe("get_challenges — an empty tracker is not a claim about Top Shot", () => {
  it("feed STALE → says RPC's tracker is behind and forbids 'Top Shot has none'", async () => {
    A.sb = makeInstrumentedSupabaseFixture({ ...empty, pipeline_runs_daily: { data: [{ day: "2026-08-28" }], error: null } }).fixture
    await POST(post())
    const r = toolResult()
    expect(r.challenge_feed).toMatchObject({ state: "stale", lastOkDay: "2026-08-28" })
    expect(r.note).toMatch(/BEHIND/)
    expect(r.note).toMatch(/Do NOT say Top Shot has none/)
  })

  it("feed CURRENT → the empty tracker reflects Top Shot", async () => {
    const today = new Date().toISOString().slice(0, 10)
    A.sb = makeInstrumentedSupabaseFixture({ ...empty, pipeline_runs_daily: { data: [{ day: today }], error: null } }).fixture
    await POST(post())
    const r = toolResult()
    expect(r.challenge_feed.state).toBe("current")
    expect(r.note).toMatch(/reflects Top Shot/)
  })

  it("freshness read FAILS → no claim about Top Shot either way", async () => {
    A.sb = makeInstrumentedSupabaseFixture({ ...empty, pipeline_runs_daily: { data: null, error: { message: "timeout" } } }).fixture
    await POST(post())
    const r = toolResult()
    expect(r.challenge_feed.state).toBe("unknown")
    expect(r.note).toMatch(/make NO claim/)
    expect(r.note).not.toMatch(/reflects Top Shot/)
  })
})

// Same pass: asked "which moments are trending up?", the concierge said the
// movers board was "returning collection-level volume" and sent the user to
// /insights/market-pulse "play-by-play with price movement" — the tool
// description promised editions "heating up or cooling", but its endpoint
// (get_market_pulse_windows) is collection-level by design.
describe("get_market_movers describes what its endpoint returns", async () => {
  const { readFileSync } = await import("node:fs")
  const { join } = await import("node:path")
  const route = readFileSync(join(__dirname, "..", "app", "api", "support-chat", "route.ts"), "utf8")
  const i = route.indexOf('name: "get_market_movers"')
  const desc = route.slice(i, i + 900)
  it("says COLLECTION-level and routes edition questions to get_hot_floors", () => {
    expect(desc).toMatch(/COLLECTION-level/)
    expect(desc).toMatch(/get_hot_floors/)
    expect(desc).not.toMatch(/which Top Shot editions are heating up/)
  })
})

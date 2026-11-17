// 2026-11-02 — `checkFeatureQuota` fails OPEN when its RPC errors (decided for "known-good wallets"). Since
// open signup every signed-in account is keyed (`user:<uuid>`) and skips the anonymous global budget, so a
// quota outage meant uncapped paid model calls for any account. The fail-open now runs under a durable
// global ceiling that fails CLOSED. Assert the ABSENCE of a model call when that ceiling refuses.
import { describe, it, expect, beforeEach, vi } from "vitest"
import { NextRequest } from "next/server"
import { makeInstrumentedSupabaseFixture } from "./helpers/route-harness"
import type { ScriptTurn } from "./helpers/anthropic-fixture"

const A = vi.hoisted(() => ({
  state: { script: [] as ScriptTurn[], cursor: 0 },
  createCalls: [] as unknown[],
  sb: null as unknown,
  quota: { allowed: true, plan: "free", used_today: 0, daily_limit: null, remaining: null, reason: "rpc_error_failopen" } as Record<string, unknown>,
  budget: { allowed: false, failed: true } as { allowed: boolean; failed: boolean },
  buckets: [] as string[],
}))
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: () => {} }
})
vi.mock("@/lib/auth/supabase-server", () => ({
  getSupabaseServer: async () => ({ auth: { getUser: async () => ({ data: { user: { id: "11111111-1111-1111-1111-111111111111", email: "c@example.com" } }, error: null }) } }),
}))
vi.mock("@/lib/pro-tier", async () => {
  const { userQuotaKey } = await import("@/lib/user-quota-key")
  return { userQuotaKey, checkFeatureQuota: async () => A.quota, recordFeatureUsage: async () => {} }
})
vi.mock("@/lib/abuse/anon-rate", () => ({
  bumpAnonRate: async (cap: { bucket: string }) => { A.buckets.push(cap.bucket); return A.budget },
  bumpAnonRates: async () => ({ allowed: true, failed: false, refusedBucket: null }),
}))
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => new Proxy({}, { get: (_t, prop) => (A.sb as Record<PropertyKey, unknown>)[prop] }),
}))
vi.mock("@anthropic-ai/sdk", async () => {
  const { buildAnthropicClass } = await import("./helpers/anthropic-fixture")
  const Base = buildAnthropicClass(A.state) as new () => { messages: { create: (a: unknown) => Promise<unknown>; stream: (a: unknown) => unknown } }
  return {
    default: class {
      messages = (() => {
        const inner = new Base().messages
        return { create: async (a: unknown) => { A.createCalls.push(a); return inner.create(a) }, stream: inner.stream }
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
    body: JSON.stringify({ message: "what is the floor of LeBron base set", sessionId: `s-${Math.random()}` }),
  })
}

beforeEach(() => {
  A.createCalls.length = 0
  A.buckets.length = 0
  A.state.script = [{ text: "ok" }]
  A.state.cursor = 0
  A.sb = makeInstrumentedSupabaseFixture({}).fixture
})

describe("concierge quota fail-open is bounded by a fail-closed global ceiling", () => {
  it("quota RPC down + ceiling unreadable → 503 and NO model call", async () => {
    A.quota = { allowed: true, plan: "free", used_today: 0, daily_limit: null, remaining: null, reason: "rpc_error_failopen" }
    A.budget = { allowed: false, failed: true }
    const res = await POST(post())
    expect(res.status).toBe(503)
    expect(A.createCalls).toHaveLength(0)
    expect(A.buckets).toContain("concierge:keyed_quota_failopen")
  })

  it("quota RPC down + ceiling exhausted → 429 and NO model call", async () => {
    A.quota = { allowed: true, plan: "free", used_today: 0, daily_limit: null, remaining: null, reason: "rpc_error_failopen" }
    A.budget = { allowed: false, failed: false }
    const res = await POST(post())
    expect(res.status).toBe(429)
    expect(A.createCalls).toHaveLength(0)
  })

  it("no-change control: a HEALTHY quota read never touches the fail-open ceiling", async () => {
    A.quota = { allowed: true, plan: "free", used_today: 1, daily_limit: 40, remaining: 39 }
    A.budget = { allowed: false, failed: true }
    await POST(post())
    expect(A.buckets).not.toContain("concierge:keyed_quota_failopen")
  })
})

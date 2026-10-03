import { describe, it, expect, beforeEach, vi } from "vitest"
import { NextRequest } from "next/server"
import { makeInstrumentedSupabaseFixture } from "./helpers/route-harness"
import type { ScriptTurn } from "./helpers/anthropic-fixture"

// 2026-10-02: from 10:49 AM PT every concierge call was refused by Anthropic
// ("Your credit balance is too low", HTTP 403 → mode credit_balance). Users got
// the canned "temporarily unavailable" line for ~10 h and NOTHING recorded it:
// only model_error wrote a pipeline_runs row. These cases pin that a billing /
// key refusal now leaves an ok=false `concierge-billing-error` row, that a model
// retirement still writes its own row, and that a rate limit writes neither.

const A = vi.hoisted(() => ({
  state: { script: [] as ScriptTurn[], cursor: 0 },
  sb: null as unknown,
  pending: [] as Array<Promise<unknown>>,
}))

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  // Run after() callbacks so the telemetry write is observable.
  return {
    ...actual,
    after: (fn: unknown) => {
      if (typeof fn === "function") A.pending.push(Promise.resolve().then(() => (fn as () => unknown)()))
    },
  }
})
vi.mock("@/lib/auth/supabase-server", () => ({
  getSupabaseServer: async () => ({
    auth: { getUser: async () => ({ data: { user: null }, error: null }) },
  }),
}))
vi.mock("@/lib/pro-tier", () => ({
  checkFeatureQuota: async () => ({ allowed: true, plan: "pro", daily_limit: 200, used_today: 0 }),
  recordFeatureUsage: async () => {},
}))
vi.mock("@supabase/supabase-js", () => ({
  createClient: () =>
    new Proxy({}, { get: (_t, prop) => (A.sb as Record<PropertyKey, unknown>)[prop] }),
}))
vi.mock("@anthropic-ai/sdk", async () => {
  const { buildAnthropicClass } = await import("./helpers/anthropic-fixture")
  return { default: buildAnthropicClass(A.state) }
})

process.env.ANTHROPIC_API_KEY = "test-key"

const { POST } = await import("@/app/api/support-chat/route")

function post(message: string): NextRequest {
  return new NextRequest("https://t/api/support-chat", {
    method: "POST",
    headers: new Headers({ "content-type": "application/json" }),
    body: JSON.stringify({ message, sessionId: `bill-${Math.random()}` }),
  })
}

async function run(error: { message: string; status: number; type: string }) {
  const spy = makeInstrumentedSupabaseFixture({})
  A.sb = spy.fixture
  A.pending.length = 0
  A.state.script = [{ error }]
  A.state.cursor = 0
  const res = await POST(post("what is my best moment worth"))
  const body = await res.json()
  await Promise.all(A.pending)
  const telemetry = spy.rpcCalls.filter(
    (c) =>
      c.name === "log_pipeline_run" &&
      String((c.args as Record<string, unknown> | undefined)?.p_pipeline ?? "").startsWith("concierge-"),
  )
  return { body, telemetry }
}

beforeEach(() => {
  A.pending.length = 0
})

describe("concierge upstream-refusal telemetry", () => {
  it("a credit-balance 403 writes an ok=false concierge-billing-error row", async () => {
    const { body, telemetry } = await run({
      message: "Your credit balance is too low to access the Anthropic API.",
      status: 403,
      type: "permission_error",
    })
    expect(String(body.response)).toContain("temporarily unavailable")
    expect(telemetry).toHaveLength(1)
    const args = telemetry[0].args as Record<string, unknown>
    expect(args.p_pipeline).toBe("concierge-billing-error")
    expect(args.p_ok).toBe(false)
    expect(String(args.p_error)).toContain("credit balance")
  })

  it("a model retirement still writes concierge-model-error, not the billing row", async () => {
    const { telemetry } = await run({ message: "model: claude-x not found", status: 404, type: "not_found_error" })
    expect(telemetry.map((c) => (c.args as Record<string, unknown>).p_pipeline)).toEqual(["concierge-model-error"])
  })

  it("a rate limit is transient and writes no refusal row", async () => {
    const { telemetry } = await run({ message: "rate limit exceeded", status: 429, type: "rate_limit_error" })
    expect(telemetry).toHaveLength(0)
  })
})

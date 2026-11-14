// 2026-09-25 — "Show me the best deals below FMV" on NFL All Day headlined Dalton
// Kincaid's Dynamic LEGENDARY at $30 vs FMV $570.86 ("95% off", "deepest dollar
// discount") — a STALE FMV built on 2024 sales. search_live_deals passed no FMV
// confidence to the model and kept the feed's order, so a discount against a
// number nothing supports led the answer. Verified-FMV rows now rank first and
// every row carries fmv_confidence + low_confidence_fmv.

import { describe, it, expect, beforeEach, vi } from "vitest"
import { NextRequest } from "next/server"
import { makeInstrumentedSupabaseFixture } from "./helpers/route-harness"
import type { ScriptTurn } from "./helpers/anthropic-fixture"
import { scrubConfidence } from "@/lib/concierge/scrub-confidence"

const A = vi.hoisted(() => ({
  state: { script: [] as ScriptTurn[], cursor: 0 },
  createCalls: [] as Array<{ system: Array<{ text: string }>; messages: Array<{ role: string; content: unknown }> }>,
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

const FEED = {
  deals: [
    { playerName: "Dalton Kincaid", setName: "Dynamic", tier: "LEGENDARY", askPrice: 30, adjustedFmv: 570.86, discount: 94.7, confidence: "stale", lowConfidenceFmv: true, source: "allday", buyUrl: "k" },
    { playerName: "Donovan Wilson", setName: "Ball Hawk", tier: "RARE", askPrice: 5, adjustedFmv: 81, discount: 93.8, confidence: "ask_only", lowConfidenceFmv: true, source: "allday", buyUrl: "w" },
    { playerName: "Alvin Kamara", setName: "Locked In", tier: "RARE", askPrice: 2, adjustedFmv: 3.67, discount: 45.5, confidence: "medium", lowConfidenceFmv: false, source: "allday", buyUrl: "a" },
  ],
}

function post(): NextRequest {
  return new NextRequest("https://t/api/support-chat", {
    method: "POST",
    headers: new Headers({ "content-type": "application/json" }),
    body: JSON.stringify({ message: "best deals below FMV", sessionId: `d-${Math.random()}`, collectionId: "nfl-all-day" }),
  })
}
function toolResult(): Record<string, any> {
  const blocks = A.createCalls.at(-1)?.messages.at(-1)?.content as Array<{ type: string; content: string }>
  const tr = blocks?.find((b) => b.type === "tool_result")
  if (!tr) throw new Error("no tool_result")
  return JSON.parse(tr.content)
}

beforeEach(() => {
  A.createCalls.length = 0
  A.sb = makeInstrumentedSupabaseFixture({}).fixture
  A.state.script = [{ tools: [{ name: "search_live_deals", input: {} }] }, { text: "done" }]
  A.state.cursor = 0
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url: any) => {
    if (String(url).includes("/api/sniper-feed")) return new Response(JSON.stringify(FEED), { status: 200 })
    return new Response("{}", { status: 404 })
  })
})

describe("search_live_deals ranks verified-FMV deals first", () => {
  it("the verified row leads; flagged rows follow and say so", async () => {
    await POST(post())
    const r = toolResult()
    // 2026-10-24: the model sees the plain-language basis, never the tier
    // (lib/concierge/scrub-confidence.ts) — the ranking itself is unchanged.
    expect(r.results[0]).toMatchObject({ player: "Alvin Kamara", fmv_pricing_basis: "priced from several recent sales", thin_pricing_fmv: false })
    const kincaid = r.results.find((x: any) => x.player === "Dalton Kincaid")
    expect(kincaid).toMatchObject({ fmv_pricing_basis: "based on older sales — may be out of date", thin_pricing_fmv: true })
    expect(r.results.findIndex((x: any) => x.thin_pricing_fmv)).toBeGreaterThan(0)
    expect(JSON.stringify(r)).not.toMatch(/confidence/i)
  })

  // Re-pinned 2026-11-14: the rule named `low_confidence_fmv`, a key the model NEVER sees —
  // scrubConfidence renames it before the tool result reaches the model, so the only signal behind
  // the rule arrived under a name the rule did not mention. Pin the PROPERTY: the prompt names the
  // key the scrubber actually emits, whatever it is called.
  it("the prompt forbids headlining a thin-pricing discount, under the key the model actually receives", async () => {
    await POST(post())
    const sys = A.createCalls[0].system.map((b) => b.text).join("\n")
    const emitted = Object.keys(JSON.parse(scrubConfidence(JSON.stringify({ low_confidence_fmv: true }))))[0]
    expect(emitted).toBeTruthy()
    expect(sys).toContain(`${emitted}: true is NOT a deal to headline`)
    expect(sys).not.toMatch(/low_confidence_fmv/)
  })
})

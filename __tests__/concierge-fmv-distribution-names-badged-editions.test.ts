// 2026-09-25 — "Is a Victor Wembanyama rookie common worth buying at $20?" was
// answered twice off the $10.80 median of his 17 commons, with "none of the
// sampled editions carry a rookie badge", while his Rookie Debut common (125:4340,
// Rookie Year + Top Shot Debut) carries a HIGH FMV of $155.05. get_fmv's
// distribution named only the most-recently-priced editions (and, after the first
// fix, the highest-FMV one — a $675 ask-only parallel), so the badged edition the
// question was about never reached the model.
//
// The route now reads badge metadata across EVERY priced edition in the
// distribution, adds the highest-FMV badged editions to sample_editions, and
// reports badged_editions_in_filter — null (never 0) when the badge read failed.

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
    body: JSON.stringify({ message: "Is a Wemby rookie common worth $20?", sessionId: `w-${Math.random()}`, collectionId: "nba-top-shot" }),
  })
}
function toolResult(): Record<string, unknown> {
  const blocks = A.createCalls.at(-1)?.messages.at(-1)?.content as Array<{ type: string; content: string }>
  const tr = blocks?.find((b) => b.type === "tool_result")
  if (!tr) throw new Error("no tool_result")
  return JSON.parse(tr.content)
}

// Seven priced commons. The rookie (r1) was priced LONGEST ago (so recency skips
// it) and is not the max (a $675 ask-only parallel is), so neither the recency
// slots nor the max slot would name it — only the badge read can.
const editions = [
  { id: "r1", external_id: "125:4340", player_name: "Victor Wembanyama", set_name: "Rookie Debut", tier: "COMMON" },
  { id: "j1", external_id: "266:8928::20", player_name: "Victor Wembanyama", set_name: "Around the World", tier: "COMMON" },
  ...["a", "b", "c", "d", "e"].map((s) => ({ id: s, external_id: `266:8928::${s}`, player_name: "Victor Wembanyama", set_name: "Clamps", tier: "COMMON" })),
]
const fmv = [
  { edition_id: "r1", fmv_usd: 155.05, confidence: "HIGH", computed_at: "2026-09-01T00:00:00Z" },
  { edition_id: "j1", fmv_usd: 675, confidence: "ASK_ONLY", computed_at: "2026-09-02T00:00:00Z" },
  ...["a", "b", "c", "d", "e"].map((s, i) => ({ edition_id: s, fmv_usd: 5 + i, confidence: "MEDIUM", computed_at: `2026-09-2${i}T00:00:00Z` })),
]
const badgeRows = [
  { external_id: "125:4340", play_tags: [{ title: "Rookie Year" }, { title: "Top Shot Debut" }], circulation_count: 4000, burned: 0, locked: 100 },
  { external_id: "266:8928::20", play_tags: [], circulation_count: 25 },
]

beforeEach(() => {
  A.createCalls.length = 0
  A.state.script = [{ tools: [{ name: "get_fmv", input: { playerName: "Victor Wembanyama", tier: "COMMON" } }] }, { text: "done" }]
  A.state.cursor = 0
})

describe("get_fmv distribution names the badged editions", () => {
  it("adds the rookie edition to the sample, with its badges, and counts badged editions across the filter", async () => {
    A.sb = makeInstrumentedSupabaseFixture({
      editions: [{ count: 7, data: null, error: null }, { data: editions, error: null }],
      "rpc:get_editions_latest_fmv": { data: fmv, error: null },
      badge_editions: { data: badgeRows, error: null },
    }).fixture
    await POST(post())
    const r = toolResult() as { mode: string; sample_editions: Array<Record<string, unknown>>; badged_editions_in_filter: number | null }
    expect(r.mode).toBe("distribution")
    const rookie = r.sample_editions.find((s) => s.external_id === "125:4340")
    expect(rookie, "the badged rookie edition is named").toBeDefined()
    expect(rookie).toMatchObject({ fmv: 155.05, confidence: "HIGH", badges: ["Rookie Year", "Top Shot Debut"], badges_status: "ok" })
    expect(r.badged_editions_in_filter).toBe(1)
    // the max-FMV edition is named too, and nothing is duplicated
    expect(r.sample_editions.some((s) => s.external_id === "266:8928::20")).toBe(true)
    const keys = r.sample_editions.map((s) => s.external_id)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it("a FAILED badge read counts nothing — badged_editions_in_filter is null, never 0, and no row claims 'no badges'", async () => {
    A.sb = makeInstrumentedSupabaseFixture({
      editions: [{ count: 7, data: null, error: null }, { data: editions, error: null }],
      "rpc:get_editions_latest_fmv": { data: fmv, error: null },
      badge_editions: { data: null, error: { message: "canceling statement due to statement timeout" } },
    }).fixture
    await POST(post())
    const r = toolResult() as { sample_editions: Array<Record<string, unknown>>; badged_editions_in_filter: number | null }
    expect(r.badged_editions_in_filter).toBeNull()
    for (const s of r.sample_editions) expect(s.badges_status).toBe("unavailable")
  })
})

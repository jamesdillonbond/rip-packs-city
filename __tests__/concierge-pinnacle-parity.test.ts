// 2026-10-26 — Disney Pinnacle ↔ Top Shot parity pass. Seven Top-Shot-only concierge tools carried
// a Candy or Panini refusal but no Pinnacle one, so on a Pinnacle page they answered with TOP SHOT
// rows (the substitution face of the honesty canon). Two of them (set completion) now answer from
// Pinnacle's own Set Tracker; the rest say not_applicable. get_top_sales now asks the board for
// Pinnacle (it read an empty shared view before).

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


function post(collectionId: string): NextRequest {
  return new NextRequest("https://t/api/support-chat", {
    method: "POST",
    headers: new Headers({ "content-type": "application/json" }),
    body: JSON.stringify({ message: "help", sessionId: `s-${Math.random()}`, collectionId }),
  })
}
function toolResult(): Record<string, any> {
  const blocks = A.createCalls.at(-1)?.messages.at(-1)?.content as Array<{ type: string; content: string }>
  const tr = blocks?.find((b) => b.type === "tool_result")
  if (!tr) throw new Error("no tool_result")
  return JSON.parse(tr.content)
}
function script(tool: string, input: Record<string, unknown>) {
  A.state.script = [{ tools: [{ name: tool, input }] }, { text: "done" }]
  A.state.cursor = 0
}

beforeEach(() => {
  A.createCalls.length = 0
})

const WALLET = "0x1234567890abcdef"

describe("Top-Shot-only tools on a Disney Pinnacle page", () => {
  // get_hot_floors left this list 2026-10-26 (pass 3): Pinnacle has its own board now — pinned below.
  for (const tool of ["get_special_serial_owners", "search_serial_deals", "get_challenges", "get_rookies"]) {
    it(`${tool} → not_applicable, no Top Shot read`, async () => {
      const inst = makeInstrumentedSupabaseFixture({})
      A.sb = inst.fixture
      const fetchSpy = vi.spyOn(globalThis, "fetch")
      script(tool, { walletAddress: WALLET })
      await POST(post("disney-pinnacle"))
      const r = toolResult()
      expect(r.status).toBe("not_applicable")
      expect(r.collection).toBe("disney-pinnacle")
      expect(inst.rpcCalls.length).toBe(0)
      // No Top Shot board read (the rookie index, challenges, sweeps …) — an unrelated background
      // fetch from the route's own bookkeeping may still appear, so assert on the reads that matter.
      expect(fetchSpy.mock.calls.map((c) => String(c[0])).filter((u) => /rookie|challenge|hot-floor|serial|special/i.test(u))).toEqual([])
      fetchSpy.mockRestore()
    })
  }

  it("CONTROL — an explicit collectionId nba-top-shot is not refused on a Pinnacle page", async () => {
    const inst = makeInstrumentedSupabaseFixture({})
    A.sb = inst.fixture
    script("get_hot_floors", { collectionId: "nba-top-shot" })
    await POST(post("disney-pinnacle"))
    expect(toolResult().status).not.toBe("not_applicable")
    expect(inst.rpcCalls.some((c) => c.name === "get_topshot_hot_floors")).toBe(true)
  })
})

describe("get_hot_floors on a Disney Pinnacle page reads Pinnacle's own sweep board (pass 3)", () => {
  it("reads get_pinnacle_hot_floors — never Top Shot's Quick-Buy board — and links pin pages", async () => {
    const inst = makeInstrumentedSupabaseFixture({
      "rpc:get_pinnacle_hot_floors": { data: { days: 7, newest_sale_at: "2026-10-27T03:43:24Z", editions: [
        { external_id: "OEV2-ALIN-CRIM-S3", player_name: "Crimson Coil", set_name: "20th Century Studios • Alien Vol.2", tier: "Silver Sparkle", circulation_count: 204, sweep_buyers: 4, swept_sales: 26, swept_spend: 26, last_swept_at: "2026-10-27T00:05:20Z", floor_ask: 2, floor_ask_verified_at: "2026-10-27T01:45:17Z", fmv_usd: 1 },
      ] }, error: null },
    })
    A.sb = inst.fixture
    script("get_hot_floors", {})
    await POST(post("disney-pinnacle"))
    const r = toolResult()
    expect(r).toMatchObject({ status: "ok", collection: "disney-pinnacle", window_days: 7, count: 1 })
    expect(r.hot_floors[0]).toMatchObject({ pin: "OEV2-ALIN-CRIM-S3", character: "Crimson Coil", sweep_buyers: 4, avg_paid_usd: 1 })
    expect(r.hot_floors[0].pin_url).toMatch(/\/pinnacle\/moment\/OEV2-ALIN-CRIM-S3$/)
    expect(r.board_url).toMatch(/\/disney-pinnacle\/hot-floors$/)
    expect(inst.rpcCalls.map((c) => c.name)).toContain("get_pinnacle_hot_floors")
    expect(inst.rpcCalls.some((c) => c.name === "get_topshot_hot_floors" || c.name === "get_allday_hot_floors")).toBe(false)
    // Collectors are counted, never named.
    expect(JSON.stringify(r)).not.toMatch(/buyer_address|0x[0-9a-f]{16}/)
  })

  it("a failed read says the check failed — never 'no pins are being swept'", async () => {
    const inst = makeInstrumentedSupabaseFixture({
      "rpc:get_pinnacle_hot_floors": { data: null, error: { message: "canceling statement due to statement timeout" } },
    })
    A.sb = inst.fixture
    script("get_hot_floors", {})
    await POST(post("disney-pinnacle"))
    const r = toolResult()
    expect(r.status).toBe("error")
    expect(r.hot_floors).toBeUndefined()
    expect(r.count).toBeUndefined()
  })
})

describe("set completion on a Disney Pinnacle page reads Pinnacle's Set Tracker", () => {
  for (const tool of ["get_set_completion_cost", "get_cheapest_sets_to_complete"]) {
    it(`${tool} → /api/pinnacle-set-progress, never Top Shot's sets`, async () => {
      const inst = makeInstrumentedSupabaseFixture({})
      A.sb = inst.fixture
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
        new Response(JSON.stringify({
          totalSets: 1, completeSets: 0, inProgressSets: 1, asksAsOf: null,
          sets: [{ setName: "Lucasfilm Ltd. • Star Wars Alphabet Vol.1", totalEditions: 26, ownedCount: 3, missingCount: 23, completionPct: 12, listedCount: 20, totalMissingCost: 140, costConfidence: "mixed", missing: [] }],
        }), { status: 200, headers: { "content-type": "application/json" } }),
      )
      script(tool, { walletAddress: WALLET, setName: "alphabet" })
      await POST(post("disney-pinnacle"))
      const r = toolResult()
      expect(r).toMatchObject({ status: "ok", collection: "disney-pinnacle" })
      expect(r.sets[0].slots_total).toBe(26)
      expect(fetchSpy.mock.calls.some((c) => String(c[0]).includes("/api/pinnacle-set-progress?wallet=0x1234567890abcdef"))).toBe(true)
      expect(inst.rpcCalls.some((c) => c.name.startsWith("get_topshot_"))).toBe(false)
      fetchSpy.mockRestore()
    })
  }

  it("a failed set read says the check failed — never 'no set progress'", async () => {
    const inst = makeInstrumentedSupabaseFixture({})
    A.sb = inst.fixture
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("{}", { status: 503 }))
    script("get_cheapest_sets_to_complete", { walletAddress: WALLET })
    await POST(post("disney-pinnacle"))
    const r = toolResult()
    expect(r.status).toBe("error")
    expect(r.message).toMatch(/never say this wallet has no set progress/)
    fetchSpy.mockRestore()
  })
})

describe("get_top_sales on a Disney Pinnacle page", () => {
  it("asks the board for disney_pinnacle (served from v_pinnacle_top_sales since 2026-10-26)", async () => {
    const inst = makeInstrumentedSupabaseFixture({})
    A.sb = inst.fixture
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(JSON.stringify({ meta: { fetched_at: "x", total_rows: 1 }, rows: [{ sale_id: "n1", collection: "disney_pinnacle", price_usd: 10990 }] }), { status: 200, headers: { "content-type": "application/json" } }),
    )
    script("get_top_sales", { window: "30d" })
    await POST(post("disney-pinnacle"))
    expect(fetchSpy.mock.calls.some((c) => String(c[0]).includes("/api/public/insights/top-sales?collection=disney_pinnacle"))).toBe(true)
    fetchSpy.mockRestore()
  })
})

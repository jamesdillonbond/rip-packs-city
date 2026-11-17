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


// 2026-11-14 (fresh-eyes review of the concierge). get_topshot_cheapest_sets_to_complete builds
// `owned` from wallet_moments_cache, so a NEVER-WALKED wallet also ranks nothing — and the tool
// called that "No Top Shot sets in progress … a real answer, not an outage". A new collector asking
// "which sets am I closest to finishing?" was told they had none started.
describe("get_cheapest_sets_to_complete — an empty ranking is only an answer for a walked wallet", () => {
  it("a never-walked wallet is not_indexed, never 'no sets in progress'", async () => {
    const inst = makeInstrumentedSupabaseFixture({
      "rpc:get_topshot_cheapest_sets_to_complete": { data: { sets: [], sets_in_progress: 0 }, error: null },
      wallet_moments_cache: { data: [], error: null },
      wallet_backfill_state: { data: [], error: null },
    })
    A.sb = inst.fixture
    script("get_cheapest_sets_to_complete", { walletAddress: WALLET })
    await POST(post("nba-top-shot"))
    const r = toolResult()
    expect(r.status).toBe("not_indexed")
    expect(r.message).not.toMatch(/real answer/)
  })

  it("a walked wallet with nothing part-finished still gets the real empty answer (control)", async () => {
    const inst = makeInstrumentedSupabaseFixture({
      "rpc:get_topshot_cheapest_sets_to_complete": { data: { sets: [], sets_in_progress: 0 }, error: null },
      wallet_moments_cache: { data: [{ wallet_address: WALLET }], error: null },
    })
    A.sb = inst.fixture
    script("get_cheapest_sets_to_complete", { walletAddress: WALLET })
    await POST(post("nba-top-shot"))
    expect(toolResult().status).toBe("no_results")
  })

  it("a failed index read is state_unknown, never 'no sets'", async () => {
    const inst = makeInstrumentedSupabaseFixture({
      "rpc:get_topshot_cheapest_sets_to_complete": { data: { sets: [], sets_in_progress: 0 }, error: null },
      wallet_moments_cache: { data: null, error: { message: "timeout" } },
    })
    A.sb = inst.fixture
    script("get_cheapest_sets_to_complete", { walletAddress: WALLET })
    await POST(post("nba-top-shot"))
    expect(toolResult().status).toBe("state_unknown")
  })
})

// 2026-11-14: a FAILED username lookup was reported as "I couldn't resolve that username" — the
// error was dropped. Seven tools; this pins two of them through the real route.
describe("concierge username lookups — a failed lookup is not 'no such username'", () => {
  for (const tool of ["get_cheapest_sets_to_complete", "get_set_completion_cost"]) {
    it(`${tool}: rpc error → username_lookup_failed`, async () => {
      const inst = makeInstrumentedSupabaseFixture({
        "rpc:resolve_topshot_username": { data: null, error: { message: "canceling statement due to statement timeout" } },
        sets: { data: [{ id: "s1", name: "Base Set", series: 4, set_id_onchain: 1 }], error: null },
      })
      A.sb = inst.fixture
      script(tool, { walletAddress: "damefan", setName: "Base Set" })
      await POST(post("nba-top-shot"))
      expect(toolResult().status).toBe("username_lookup_failed")
    })
  }
})

// 2026-11-14: analyze_wallet_holdings answered "0" for a never-walked wallet ("how many Lakers moments
// do I own?"), and did not fold an upper-case address the cache stores lower-case.
describe("analyze_wallet_holdings — zero is only an answer for a walked wallet", () => {
  it("a never-walked wallet is not_indexed, and the key reaches the RPC folded", async () => {
    const inst = makeInstrumentedSupabaseFixture({
      "rpc:concierge_wallet_breakdown": { data: { status: "ok", total_moments: 0, groups: [] }, error: null },
      wallet_moments_cache: { data: [], error: null },
      wallet_backfill_state: { data: [], error: null },
    })
    A.sb = inst.fixture
    script("analyze_wallet_holdings", { walletAddress: "0x1234567890ABCDEF", team: "Lakers" })
    await POST(post("nba-top-shot"))
    expect(toolResult().status).toBe("not_indexed")
    const call = inst.rpcCalls.find((c: any) => c.name === "concierge_wallet_breakdown")
    expect(call?.args?.p_wallet).toBe("0x1234567890abcdef")
  })
})

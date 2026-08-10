import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"
import {
  makeInstrumentedSupabaseFixture,
  installFetchMock,
  jsonRoute,
  type FetchStub,
} from "./helpers/route-harness"
import type { ScriptTurn } from "./helpers/anthropic-fixture"

// Concierge check_wallet — the FALLBACK ladders beneath the indexed-cache happy
// path. The indexed-cache success + the username-not-resolved miss are already
// pinned by the sibling populated files; these two legs were dark:
//   1. the wallet is NOT indexed yet (get_wallet_collection_snapshot returns
//      totalMoments 0) → the LIVE Top Shot walk via /api/wallet-search, whose
//      `source: "live_walk_first_page"` result was asserted NOWHERE (only in
//      comments) despite carrying the load-bearing honesty note that the FMV
//      covers ONLY the returned page, not the whole wallet.
//   2. a non-hex handle that MISSES the resolve RPC but is then found by the live
//      /api/resolve-topshot-username fallback → resolution proceeds with the
//      recovered address (distinct from the miss→miss username_not_resolved leg).
// Same harness + mocks as api-support-chat-tools-populated.test.ts.

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
process.env.INGEST_SECRET_TOKEN = "ingest-secret"

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
    body: JSON.stringify({ message, sessionId: `cwf-${Math.random()}`, ...extra }),
  })
}

function script(toolName: string, input: unknown) {
  A.state.script = [{ tools: [{ name: toolName, input }] }, { text: "done" }]
  A.state.cursor = 0
}

/** The tool_result JSON the handler produced, as fed to iteration 2. */
function toolResult(): Record<string, unknown> {
  const secondCall = A.createCalls.at(-1)
  const lastMsg = secondCall?.messages.at(-1)
  const blocks = lastMsg?.content as Array<{ type: string; content: string }>
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

const WALLET = "0xbd94cade097e50ac"

describe("concierge check_wallet — live-walk fallback (wallet not indexed)", () => {
  it("falls back to the live Top Shot walk and flags the page-only FMV honestly", async () => {
    // Snapshot returns 0 moments → the wallet isn't in the index yet → live walk.
    install({
      "rpc:get_wallet_collection_snapshot": {
        data: { totalMoments: 0, totalFmv: 0, perCollection: [] },
        error: null,
      },
    })
    stubFetch([
      jsonRoute("/api/wallet-search", {
        summary: { totalMoments: 137 },
        moments: [
          { playerName: "Ja Morant", setName: "Base Set", tier: "COMMON", serialNumber: 12, fmv: 40 },
          { playerName: "LeBron James", setName: "MVP", tier: "RARE", serialNumber: 3, fmv: 260 },
        ],
      }),
    ])
    script("check_wallet", { walletAddress: WALLET })

    const res = await POST(post("check my wallet"))
    expect(res.status).toBe(200)

    const tr = toolResult()
    expect(tr).toMatchObject({
      status: "ok",
      source: "live_walk_first_page",
      wallet: WALLET,
      // total_moments is the true owned count from the summary, NOT the page length.
      total_moments: 137,
      returned_moments: 2,
    })
    // The page FMV is the sum of only the returned rows (40 + 260), reported as a
    // string with the honesty note — never presented as the whole-wallet FMV.
    expect(tr.fmv_of_returned_page).toBe("300.00")
    expect(String(tr.note)).toContain("ONLY the returned page")
    expect((tr.top_moments as unknown[]).length).toBe(2)
  })

  it("surfaces a graceful error when the live walk returns an error string", async () => {
    install({
      "rpc:get_wallet_collection_snapshot": {
        data: { totalMoments: 0, totalFmv: 0, perCollection: [] },
        error: null,
      },
    })
    stubFetch([jsonRoute("/api/wallet-search", { error: "Username not found." })])
    script("check_wallet", { walletAddress: WALLET })

    await POST(post("check my wallet"))
    const tr = toolResult()
    expect(tr).toMatchObject({ status: "error", wallet: WALLET })
    expect(String(tr.message)).toContain("Username not found")
  })
})

describe("concierge check_wallet — username recovered via the live resolver", () => {
  it("resolves a non-hex handle through the live fallback when the cache RPC misses", async () => {
    // The resolve RPC misses (found:false), then the live /api/resolve-topshot-username
    // endpoint finds the wallet — resolution must PROCEED with the recovered address,
    // not stop at username_not_resolved.
    install({
      "rpc:resolve_topshot_username": { data: { found: false }, error: null },
      "rpc:get_wallet_collection_snapshot": {
        data: {
          totalMoments: 5,
          totalFmv: 1234.5,
          perCollection: [{ slug: "nba_top_shot", moments: 5, fmv: 1234.5 }],
          topMoments: [],
        },
        error: null,
      },
    })
    stubFetch([
      jsonRoute("/api/resolve-topshot-username", { found: true, wallet_address: WALLET }),
    ])
    script("check_wallet", { walletAddress: "dame_lillard" })

    await POST(post("check dame_lillard"))
    const tr = toolResult()
    expect(tr).toMatchObject({
      status: "ok",
      source: "indexed_cache",
      wallet: WALLET,
      // the original handle is echoed back since the input was not hex
      username_input: "dame_lillard",
      total_moments_all_collections: 5,
    })
  })
})

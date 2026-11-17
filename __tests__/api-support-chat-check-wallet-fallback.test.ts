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

// 2026-10-11 — the fabricated-zero shapes in check_wallet. Each case asserts the
// ABSENCE of the false claim (a $0 / 0-moments figure, a "no priced moments"
// empty list), not merely the presence of a note.
describe("concierge check_wallet — failed or unknown reads never render as zero", () => {
  it("live walk: an unpriced moment is null, not $0, and the page sum covers priced moments only", async () => {
    install({
      "rpc:get_wallet_collection_snapshot": { data: { totalMoments: 0, totalFmv: 0, perCollection: [] }, error: null },
    })
    stubFetch([
      jsonRoute("/api/wallet-search", {
        summary: { totalMoments: 3 },
        moments: [
          { playerName: "A", setName: "S", tier: "COMMON", serialNumber: 1, fmv: 10 },
          { playerName: "B", setName: "S", tier: "COMMON", serialNumber: 2, fmv: null },
          { playerName: "C", setName: "S", tier: "COMMON", serialNumber: 3 },
        ],
      }),
    ])
    script("check_wallet", { walletAddress: WALLET })
    await POST(post("check my wallet"))
    const tr = toolResult()
    expect(tr.fmv_of_returned_page).toBe("10.00")
    expect(tr.priced_moments_on_page).toBe(1)
    const fmvs = (tr.top_moments as Array<{ fmv: unknown }>).map((m) => m.fmv)
    expect(fmvs).toEqual([10, null, null])
  })

  it("live walk: no priced moment at all reports a null page FMV, never \"0.00\"", async () => {
    install({
      "rpc:get_wallet_collection_snapshot": { data: { totalMoments: 0, totalFmv: 0, perCollection: [] }, error: null },
    })
    stubFetch([
      jsonRoute("/api/wallet-search", {
        summary: { totalMoments: 1 },
        moments: [{ playerName: "B", setName: "S", tier: "COMMON", serialNumber: 2 }],
      }),
    ])
    script("check_wallet", { walletAddress: WALLET })
    await POST(post("check my wallet"))
    const tr = toolResult()
    expect(tr.fmv_of_returned_page).toBeNull()
    expect(tr.fmv_of_returned_page).not.toBe("0.00")
  })

  it("live walk: a non-OK HTTP response is an error, not an empty wallet", async () => {
    install({
      "rpc:get_wallet_collection_snapshot": { data: { totalMoments: 0, totalFmv: 0, perCollection: [] }, error: null },
    })
    stubFetch([jsonRoute("/api/wallet-search", { moments: [] }, { status: 503, ok: false })])
    script("check_wallet", { walletAddress: WALLET })
    await POST(post("check my wallet"))
    const tr = toolResult()
    expect(tr.status).toBe("error")
    expect(tr).not.toHaveProperty("total_moments")
    expect(String(tr.message)).toContain("do NOT say the wallet is empty")
  })

  it("indexed path: a failed top-moments read is flagged unavailable, not an empty list that reads as 'nothing priced'", async () => {
    install({
      "rpc:get_wallet_collection_snapshot": {
        data: { totalMoments: 5, totalFmv: 100, perCollection: [{ slug: "nba_top_shot", moments: 5, fmv: 100 }], topMoments: [] },
        error: null,
      },
      wallet_moments_cache: { data: null, error: { message: "canceling statement due to statement timeout" } },
    })
    script("check_wallet", { walletAddress: WALLET, collectionId: "nba-top-shot" })
    await POST(post("check my wallet"))
    const cd = toolResult().collection_detail as Record<string, unknown>
    expect(cd.top_moments_status).toBe("unavailable")
    expect(String(cd.top_moments_note)).toContain("FAILED")
    expect(cd.total_moments).toBe(5)
  })

  // Re-pinned 2026-10-19 (premise changed, not inverted): Panini was the subject
  // here only as "a collection the old hardcoded map lacked". Panini no longer takes
  // a wallet at all (its owners are usernames; check_wallet reads its own tab), so
  // the registry-resolution property is held by UFC, whose app id ("ufc") and DB
  // slug ("ufc_strike") differ — a local copy that missed it would still red this.
  it("indexed path: a collection resolved through the registry (ufc → ufc_strike) is not a hardcoded-map miss", async () => {
    install({
      "rpc:get_wallet_collection_snapshot": {
        data: { totalMoments: 7, totalFmv: 70, perCollection: [{ slug: "ufc_strike", moments: 7, fmv: 70 }], topMoments: [] },
        error: null,
      },
    })
    script("check_wallet", { walletAddress: WALLET, collectionId: "ufc" })
    await POST(post("check my wallet"))
    const cd = toolResult().collection_detail as Record<string, unknown>
    expect(cd).toMatchObject({ total_moments: 7, portfolio_fmv: 70, top_moments_status: "ok" })
  })

  it("a Flow wallet on Panini is refused, never a Flow snapshot under Panini's label", async () => {
    install({
      "rpc:get_wallet_collection_snapshot": {
        data: { totalMoments: 7, totalFmv: 70, perCollection: [{ slug: "nba_top_shot", moments: 7, fmv: 70 }], topMoments: [] },
        error: null,
      },
    })
    script("check_wallet", { walletAddress: WALLET, collectionId: "panini-blockchain" })
    await POST(post("check my wallet"))
    const r = toolResult()
    expect(r.status).toBe("unsupported_collection")
    expect(r.collection_detail).toBeUndefined()
  })
})

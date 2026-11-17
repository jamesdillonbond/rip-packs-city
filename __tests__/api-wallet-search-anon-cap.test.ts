import { describe, it, expect, vi } from "vitest"

// CISO pass 2026-11-04 (API authorization finding 5): POST /api/wallet-search is anon-public
// and every call runs Cadence + service-role writes for ANY wallet, with only the per-lambda
// proxy limiter in front (a 70-request burst saw zero 429s). It now carries a DURABLE anon cap.
// What must hold: (1) a refused counter → 429 with no lookup; (2) a counter that cannot be
// read fails CLOSED; (3) a signed-in caller is not capped here; (4) `input` is bounded.

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: (fn: () => unknown) => void fn() }
})
vi.mock("@/lib/chains/flow/flow", () => ({ default: { query: async () => [] } }))
vi.mock("@/lib/chains/flow/topshot", () => ({ topshotGraphql: async () => ({}) }))
vi.mock("@/lib/supabase", () => ({ supabaseAdmin: { from: () => ({}), rpc: async () => ({ data: null, error: null }) } }))
vi.mock("@/lib/rewards", () => ({ awardPoints: async () => {} }))

const state = { user: null as null | { id: string }, verdict: { allowed: true, failed: false, count: 1 as number | null, refusedBucket: null as string | null }, bumps: 0 }
vi.mock("@/lib/auth/supabase-server", () => ({ getCurrentUser: async () => state.user }))
vi.mock("@/lib/abuse/anon-rate", () => ({
  anonIpKey: () => "203.0.113.9",
  bumpAnonRates: async () => {
    state.bumps += 1
    return state.verdict
  },
}))

import { POST } from "@/app/api/wallet-search/route"
const req = (body: unknown) => ({ json: async () => body, headers: new Headers({ "x-forwarded-for": "203.0.113.9" }) }) as never

describe("POST /api/wallet-search anon cap", () => {
  it("a refused counter is a 429 and the lookup is not run", async () => {
    state.user = null
    state.verdict = { allowed: false, failed: false, count: 121, refusedBucket: "wallet_search:ip" }
    const res = await POST(req({ input: "0xbd94cade097e50ac" }))
    expect(res.status).toBe(429)
    expect(res.headers.get("retry-after")).toBe("600")
    const json = await res.json()
    expect(json.rows).toEqual([])
    expect(json.error).toMatch(/too many lookups/i)
  })
  it("an unreadable counter fails closed", async () => {
    state.user = null
    state.verdict = { allowed: false, failed: true, count: null, refusedBucket: "wallet_search:global" }
    expect((await POST(req({ input: "0xbd94cade097e50ac" }))).status).toBe(429)
  })
  it("a signed-in caller is not metered by the anon cap", async () => {
    state.user = { id: "u-1" }
    state.verdict = { allowed: false, failed: false, count: 999, refusedBucket: "wallet_search:ip" }
    const before = state.bumps
    const res = await POST(req({ input: "0xbd94cade097e50ac" }))
    expect(res.status).not.toBe(429)
    expect(state.bumps).toBe(before)
  })
  it("a 400 for a malformed body never spends the counter, and an oversize input is a 400", async () => {
    state.user = null
    state.verdict = { allowed: true, failed: false, count: 1, refusedBucket: null }
    const before = state.bumps
    expect((await POST(req({}))).status).toBe(400)
    expect((await POST(req({ input: "x".repeat(201) }))).status).toBe(400)
    expect(state.bumps).toBe(before)
  })
})

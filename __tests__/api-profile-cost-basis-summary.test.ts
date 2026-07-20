import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for /api/profile/cost-basis-summary.
// getCurrentUser()-gated but fail-SOFT: every failure mode returns 200 with the
// zero-valued EMPTY_PAYLOAD + a meta flag (never 500) so the card renders an
// empty state. Beyond the guard/empty branches this pins the aggregation core:
//   - totalFmv sums EVERY (wallet × collection) row (cached_fmv is per-collection)
//   - get_wallet_cost_basis is called ONCE per DISTINCT wallet (the dedup that
//     fixed the ~4× spend inflation / fake -79% P/L)
//   - wallet_addr is 0x-normalized; empty / "0x" addrs are skipped
//   - only buy_price > 0 acquisitions count; plPercent is null when spend is 0
//   - a per-wallet cost-basis RPC error skips that wallet (fmv still counted)

// state + rpc live in vi.hoisted so the (hoisted) vi.mock factories can reference
// them without a TDZ error.
const h = vi.hoisted(() => {
  const state: {
    user: any
    savedWallets: { data: any; error: any }
    costBasis: Record<string, { data: any; error: any }>
  } = { user: null, savedWallets: { data: [], error: null }, costBasis: {} }
  const rpc = vi.fn(async (name: string, args?: any) => {
    if (name === "get_user_saved_wallets") return state.savedWallets
    if (name === "get_wallet_cost_basis") return state.costBasis[args?.p_wallet] ?? { data: [], error: null }
    return { data: null, error: null }
  })
  return { state, rpc }
})
const { state, rpc } = h

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: { rpc: h.rpc } }))
vi.mock("@/lib/auth/supabase-server", () => ({ getCurrentUser: async () => h.state.user }))

import { GET } from "@/app/api/profile/cost-basis-summary/route"

const cbCalls = () => rpc.mock.calls.filter((c) => c[0] === "get_wallet_cost_basis")

beforeEach(() => {
  state.user = null
  state.savedWallets = { data: [], error: null }
  state.costBasis = {}
  rpc.mockClear()
})

describe("GET /api/profile/cost-basis-summary — guards / empty", () => {
  it("returns the empty payload + meta.unauthenticated when not signed in (fail-soft)", async () => {
    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ totalSpent: 0, totalPurchases: 0, totalFmv: 0, netPL: 0, plPercent: null })
    expect(body.meta.unauthenticated).toBe(true)
  })

  it("returns meta.no_wallets for an authed user with no saved wallets", async () => {
    state.user = { id: "u1" }
    const res = await GET()
    expect((await res.json()).meta.no_wallets).toBe(true)
  })

  it("returns meta.saved_wallets_unavailable when the wallet RPC errors", async () => {
    state.user = { id: "u1" }
    state.savedWallets = { data: null, error: { message: "db", code: "500" } }
    expect((await GET().then((r) => r.json())).meta.saved_wallets_unavailable).toBe(true)
  })

  it("returns meta.unexpected_error when the RPC throws", async () => {
    state.user = { id: "u1" }
    rpc.mockImplementationOnce(async () => {
      throw new Error("boom")
    })
    expect((await GET().then((r) => r.json())).meta.unexpected_error).toBe(true)
  })
})

describe("GET /api/profile/cost-basis-summary — aggregation", () => {
  it("sums fmv across all rows but calls cost-basis once per DISTINCT wallet", async () => {
    state.user = { id: "u1" }
    // wallet "abc" appears twice (two collections), "0xdef" once
    state.savedWallets = {
      data: [
        { wallet_addr: "abc", cached_fmv_usd: 10 },
        { wallet_addr: "abc", cached_fmv_usd: 5 },
        { wallet_addr: "0xdef", cached_fmv_usd: 20 },
      ],
      error: null,
    }
    state.costBasis = {
      "0xabc": { data: [{ buy_price: 4 }, { buy_price: 0 }, { buy_price: 6 }], error: null }, // 10 spent, 2 buys
      "0xdef": { data: [{ buy_price: 20 }], error: null }, // 20 spent, 1 buy
    }
    const body = await GET().then((r) => r.json())
    expect(body.totalFmv).toBe(35) // 10 + 5 + 20 — every row
    expect(body.totalSpent).toBe(30) // 10 + 20 — buy_price>0 only
    expect(body.totalPurchases).toBe(3)
    expect(body.netPL).toBe(5) // 35 - 30
    expect(body.plPercent).toBe(16.67) // 5/30*100, 2dp
    // dedup: cost-basis called for the two DISTINCT wallets only (not 3×)
    expect(cbCalls()).toHaveLength(2)
    expect(cbCalls().map((c) => c[1].p_wallet).sort()).toEqual(["0xabc", "0xdef"])
  })

  it("skips empty / '0x' addresses and rows whose cost-basis RPC errors (fmv still counts)", async () => {
    state.user = { id: "u1" }
    state.savedWallets = {
      data: [
        { wallet_addr: "", cached_fmv_usd: 1 }, // empty addr → skipped for cost basis
        { wallet_addr: "0x", cached_fmv_usd: 2 }, // "0x" alone → skipped
        { wallet_addr: "0xghi", cached_fmv_usd: 7 }, // cost-basis errors → skipped
      ],
      error: null,
    }
    state.costBasis = { "0xghi": { data: null, error: { message: "cb fail", code: "x" } } }
    const body = await GET().then((r) => r.json())
    expect(body.totalFmv).toBe(10) // 1 + 2 + 7, all rows counted
    expect(body.totalSpent).toBe(0)
    expect(body.plPercent).toBeNull() // no spend → null
    expect(cbCalls()).toHaveLength(1) // only 0xghi was eligible
  })

  it("plPercent is null when there is fmv but zero qualifying spend", async () => {
    state.user = { id: "u1" }
    state.savedWallets = { data: [{ wallet_addr: "0xzzz", cached_fmv_usd: 50 }], error: null }
    state.costBasis = { "0xzzz": { data: [{ buy_price: 0 }, { buy_price: null }], error: null } }
    const body = await GET().then((r) => r.json())
    expect(body.totalFmv).toBe(50)
    expect(body.totalSpent).toBe(0)
    expect(body.netPL).toBe(50)
    expect(body.plPercent).toBeNull()
  })
})

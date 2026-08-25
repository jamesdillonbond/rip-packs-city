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

  // INVERTED, not deleted. This PINNED the defect. The empty payload is
  // `totalSpent: 0, totalPurchases: 0, totalFmv: 0, netPL: 0` — a FABRICATED
  // FINANCIAL NUMBER about the reader's own money, served at HTTP 200.
  // `CostBasisCard` has an errored state and it was UNREACHABLE through this
  // route: it triggers on `typeof d.totalSpent !== "number"`, and 0 is a number.
  it("does not publish a $0 portfolio when the wallet RPC errors", async () => {
    state.user = { id: "u1" }
    state.savedWallets = { data: null, error: { message: "db", code: "500" } }
    const res = await GET()
    expect(res.status).toBeGreaterThanOrEqual(500)
    const body = await res.json()
    expect(body.totalSpent).toBeUndefined()
    expect(body.netPL).toBeUndefined()
  })

  // INVERTED, same reason.
  it("does not publish a $0 portfolio when the RPC throws", async () => {
    state.user = { id: "u1" }
    rpc.mockImplementationOnce(async () => {
      throw new Error("boom")
    })
    const res = await GET()
    expect(res.status).toBeGreaterThanOrEqual(500)
    expect((await res.json()).netPL).toBeUndefined()
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

  // 🚨 INVERTED, and its OLD TITLE IS THE SHARPEST "the title is the tell" case
  // in this file: "rows whose cost-basis RPC errors (fmv still counts)" states
  // the profit-fabricating asymmetry AS THE CONTRACT. `totalFmv` accumulates
  // for every wallet row BEFORE the cost-basis call, so skipping an errored
  // wallet drops only the SPEND side — the two halves of `netPL = totalFmv -
  // totalSpent` then cover DIFFERENT wallet sets and the result is biased in
  // one direction. The old assertions encode it exactly: totalFmv 10, spend 0.
  // A timeout on one wallet showed the reader a profit they had not made.
  it("does not publish a netPL whose two halves cover different wallets", async () => {
    state.user = { id: "u1" }
    state.savedWallets = {
      data: [
        { wallet_addr: "", cached_fmv_usd: 1 },
        { wallet_addr: "0x", cached_fmv_usd: 2 },
        { wallet_addr: "0xghi", cached_fmv_usd: 7 }, // cost-basis errors
      ],
      error: null,
    }
    state.costBasis = { "0xghi": { data: null, error: { message: "cb fail", code: "x" } } }
    const res = await GET()
    expect(res.status).toBeGreaterThanOrEqual(500)
    const body = await res.json()
    expect(body.totalFmv).toBeUndefined()
    expect(body.netPL).toBeUndefined()
  })

  it("still skips unusable addresses without failing — positive control", async () => {
    // The address filter is NOT an error path: an empty or bare "0x" address is
    // legitimately not cost-basis-able, and its fmv genuinely does still count.
    // Without this control the case above is satisfiable by a route that errors
    // on any unusable address, which would break every multi-collection wallet.
    state.user = { id: "u1" }
    state.savedWallets = {
      data: [
        { wallet_addr: "", cached_fmv_usd: 1 },
        { wallet_addr: "0x", cached_fmv_usd: 2 },
      ],
      error: null,
    }
    state.costBasis = {}
    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.totalFmv).toBe(3)
    expect(body.totalSpent).toBe(0)
    expect(body.plPercent).toBeNull()
    expect(cbCalls()).toHaveLength(0)
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

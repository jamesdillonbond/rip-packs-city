import { describe, it, expect, beforeEach, vi } from "vitest"

// Pins lib/pro.ts (distinct from lib/pro-tier.ts) — the pro_users table reads
// behind isProUser / getProStatus. Both walk .from().select().eq().limit()
// .maybeSingle(), so we stub that chain and assert: wallet is lowercased into
// the eq filter, the null-expiry "lifetime" branch, the future/past expires_at
// comparison, and the error/no-row fallbacks (false / default status shape).

const state: { single: { data: any; error: any }; eqArg: any } = {
  single: { data: null, error: null },
  eqArg: null,
}

vi.mock("@/lib/supabase", () => {
  const build = () => {
    const b: any = {
      select: () => b,
      eq: (_col: string, val: any) => {
        state.eqArg = val
        return b
      },
      limit: () => b,
      maybeSingle: async () => state.single,
    }
    return b
  }
  const client: any = { from: () => build() }
  return { supabase: client, supabaseAdmin: client }
})

import { isProUser, getProStatus } from "@/lib/pro"

const FUTURE = new Date(Date.now() + 86_400_000).toISOString()
const PAST = new Date(Date.now() - 86_400_000).toISOString()

beforeEach(() => {
  state.single = { data: null, error: null }
  state.eqArg = null
})

describe("isProUser", () => {
  it("lowercases the wallet into the eq filter", async () => {
    state.single = { data: { id: "1", expires_at: null }, error: null }
    await isProUser("0xABCDEF")
    expect(state.eqArg).toBe("0xabcdef")
  })

  it("is true for a lifetime row (expires_at null)", async () => {
    state.single = { data: { id: "1", expires_at: null }, error: null }
    expect(await isProUser("0xabc")).toBe(true)
  })

  it("is true when expires_at is in the future, false when in the past", async () => {
    state.single = { data: { id: "1", expires_at: FUTURE }, error: null }
    expect(await isProUser("0xabc")).toBe(true)
    state.single = { data: { id: "1", expires_at: PAST }, error: null }
    expect(await isProUser("0xabc")).toBe(false)
  })

  it("is false on a missing row or an error", async () => {
    state.single = { data: null, error: null }
    expect(await isProUser("0xabc")).toBe(false)
    state.single = { data: { id: "1", expires_at: null }, error: { message: "x" } }
    expect(await isProUser("0xabc")).toBe(false)
  })
})

describe("getProStatus", () => {
  it("returns the not-pro default shape on a missing row or error", async () => {
    state.single = { data: null, error: null }
    expect(await getProStatus("0xabc")).toEqual({ isPro: false, plan: null, expiresAt: null })
    state.single = { data: { plan: "paid", expires_at: null }, error: { message: "x" } }
    expect(await getProStatus("0xabc")).toEqual({ isPro: false, plan: null, expiresAt: null })
  })

  it("reports lifetime pro (expires_at null) with the plan passed through", async () => {
    state.single = { data: { plan: "founding", expires_at: null }, error: null }
    expect(await getProStatus("0xABC")).toEqual({
      isPro: true,
      plan: "founding",
      expiresAt: null,
    })
    expect(state.eqArg).toBe("0xabc") // lowercased
  })

  it("reports pro true for a future expiry and false for a past expiry", async () => {
    state.single = { data: { plan: "paid", expires_at: FUTURE }, error: null }
    expect(await getProStatus("0xabc")).toMatchObject({ isPro: true, expiresAt: FUTURE })
    state.single = { data: { plan: "paid", expires_at: PAST }, error: null }
    expect(await getProStatus("0xabc")).toMatchObject({ isPro: false, expiresAt: PAST })
  })
})

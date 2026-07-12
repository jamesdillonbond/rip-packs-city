import { describe, it, expect, beforeEach, vi } from "vitest"

// Pins lib/pro-tier.ts — the server-side Pro-plan / feature-quota gating that
// guards monetized features. All four helpers dispatch through Postgres RPCs
// (get_user_plan / check_feature_quota / record_feature_usage), so we stub the
// supabaseAdmin.rpc seam and assert: wallet normalization, PRO_PLANS membership,
// the anonymous-vs-known fail-open/fail-closed split, and the 402 requirePro
// guard. A regression here silently opens or wrongly closes paid features.

const state: { rpc: (name: string, args: any) => Promise<{ data: any; error: any }> } = {
  rpc: async () => ({ data: null, error: null }),
}

vi.mock("@/lib/supabase", () => {
  const client: any = { rpc: (name: string, args: any) => state.rpc(name, args) }
  return { supabase: client, supabaseAdmin: client }
})

import {
  getUserPlan,
  isProUser,
  checkFeatureQuota,
  recordFeatureUsage,
  requirePro,
} from "@/lib/pro-tier"

const WALLET = "0xbd94cade097e50ac"

beforeEach(() => {
  state.rpc = async () => ({ data: null, error: null })
})

describe("getUserPlan", () => {
  it("returns 'free' for a null / malformed wallet without calling the RPC", async () => {
    const spy = vi.fn(async () => ({ data: "admin", error: null }))
    state.rpc = spy
    expect(await getUserPlan(null)).toBe("free")
    expect(await getUserPlan("0xNOTHEX")).toBe("free")
    expect(await getUserPlan("bd94cade097e50ac")).toBe("free") // missing 0x prefix
    expect(spy).not.toHaveBeenCalled()
  })

  it("normalizes the wallet (lowercase) before the RPC and returns the plan", async () => {
    let seen: any = null
    state.rpc = async (_n, args) => {
      seen = args
      return { data: "pro_paid", error: null }
    }
    expect(await getUserPlan("0xBD94CADE097E50AC")).toBe("pro_paid")
    expect(seen).toEqual({ p_wallet: WALLET })
  })

  it("falls back to 'free' on an RPC error or a non-string payload", async () => {
    state.rpc = async () => ({ data: null, error: { message: "x" } })
    expect(await getUserPlan(WALLET)).toBe("free")
    state.rpc = async () => ({ data: 42, error: null })
    expect(await getUserPlan(WALLET)).toBe("free")
  })
})

describe("isProUser", () => {
  it("is true for every PRO plan and false for free", async () => {
    for (const plan of ["founding", "moments_payment", "pro_grandfather", "pro_paid", "pro_trial", "admin"]) {
      state.rpc = async () => ({ data: plan, error: null })
      expect(await isProUser(WALLET)).toBe(true)
    }
    state.rpc = async () => ({ data: "free", error: null })
    expect(await isProUser(WALLET)).toBe(false)
  })
})

describe("checkFeatureQuota", () => {
  it("anonymous wallet probes the sentinel zero-address and returns its quota", async () => {
    let seen: any = null
    state.rpc = async (_n, args) => {
      seen = args
      return { data: { allowed: false, plan: "free", used_today: 3, daily_limit: 3, remaining: 0, reason: "cap" }, error: null }
    }
    const q = await checkFeatureQuota(null, "concierge")
    expect(seen).toEqual({ p_wallet: "0x0000000000000000", p_feature: "concierge" })
    expect(q.allowed).toBe(false)
    expect(q.remaining).toBe(0)
  })

  it("anonymous wallet fails CLOSED on an RPC error (allowed:false)", async () => {
    state.rpc = async () => ({ data: null, error: { message: "down" } })
    const q = await checkFeatureQuota(null, "concierge")
    expect(q.allowed).toBe(false)
    expect(q.reason).toBe("rpc_error")
  })

  it("known wallet fails OPEN on an RPC error (allowed:true, unlimited)", async () => {
    state.rpc = async () => ({ data: null, error: { message: "down" } })
    const q = await checkFeatureQuota(WALLET, "concierge")
    expect(q.allowed).toBe(true)
    expect(q.reason).toBe("rpc_error_failopen")
    expect(q.daily_limit).toBeNull()
  })

  it("known wallet returns the RPC quota verbatim", async () => {
    state.rpc = async () => ({ data: { allowed: true, plan: "pro_paid", used_today: 1, daily_limit: null, remaining: null, reason: "unlimited" }, error: null })
    const q = await checkFeatureQuota(WALLET, "alerts")
    expect(q).toMatchObject({ allowed: true, plan: "pro_paid", reason: "unlimited" })
  })
})

describe("recordFeatureUsage", () => {
  it("no-ops (no RPC) for a malformed wallet", async () => {
    const spy = vi.fn(async () => ({ data: null, error: null }))
    state.rpc = spy
    await recordFeatureUsage("bad", "concierge")
    expect(spy).not.toHaveBeenCalled()
  })

  it("records for a valid wallet and swallows RPC failures", async () => {
    const spy = vi.fn(async () => {
      throw new Error("write failed")
    })
    state.rpc = spy as any
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    await expect(recordFeatureUsage(WALLET, "concierge", { n: 1 })).resolves.toBeUndefined()
    expect(spy).toHaveBeenCalledOnce()
    warn.mockRestore()
  })
})

describe("requirePro", () => {
  it("returns null (pass) for a pro plan", async () => {
    state.rpc = async () => ({ data: "founding", error: null })
    expect(await requirePro(WALLET)).toBeNull()
  })

  it("returns a 402 with the upgrade url for a free plan", async () => {
    state.rpc = async () => ({ data: "free", error: null })
    const res = await requirePro(WALLET, "/pricing")
    expect(res).not.toBeNull()
    expect(res!.status).toBe(402)
    const body = await res!.json()
    expect(body.error).toBe("pro_required")
    expect(body.upgrade_url).toBe("/pricing")
    expect(body.plan).toBe("free")
  })
})

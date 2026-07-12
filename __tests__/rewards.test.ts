import { describe, it, expect, beforeEach, vi } from "vitest"

// Pins lib/rewards.ts — the off-chain points economy wrappers. Every mover
// (award_points / redeem_shop_item / admin_adjust_points) dispatches through a
// SECURITY DEFINER Postgres RPC on the service-role client, so we stub the
// supabaseAdmin.rpc seam and assert the missing-user guards, the exact RPC
// param mapping, and the distinct error shapes each helper returns.

const state: { rpc: (name: string, args: any) => Promise<{ data: any; error: any }> } = {
  rpc: async () => ({ data: null, error: null }),
}

vi.mock("@/lib/supabase", () => {
  const client: any = { rpc: (name: string, args: any) => state.rpc(name, args) }
  return { supabase: client, supabaseAdmin: client }
})

import { awardPoints, redeemItem, getRewardsSummary, adminAdjust } from "@/lib/rewards"

beforeEach(() => {
  state.rpc = async () => ({ data: null, error: null })
  vi.spyOn(console, "log").mockImplementation(() => {})
})

describe("awardPoints", () => {
  it("returns null for a missing userId without calling the RPC", async () => {
    const spy = vi.fn(async () => ({ data: { awarded: true }, error: null }))
    state.rpc = spy
    expect(await awardPoints("", "share_card")).toBeNull()
    expect(spy).not.toHaveBeenCalled()
  })

  it("maps params (p_ref defaults to null) and returns the jsonb payload", async () => {
    let seenName: any = null
    let seen: any = null
    state.rpc = async (name, args) => {
      seenName = name
      seen = args
      return { data: { awarded: true, points: 10 }, error: null }
    }
    const data = await awardPoints("u1", "share_card")
    expect(seenName).toBe("award_points")
    expect(seen).toEqual({ p_user_id: "u1", p_action_key: "share_card", p_ref: null })
    expect(data).toEqual({ awarded: true, points: 10 })
  })

  it("passes an explicit ref through and returns null on RPC error", async () => {
    let seen: any = null
    state.rpc = async (_n, args) => {
      seen = args
      return { data: null, error: { message: "boom" } }
    }
    expect(await awardPoints("u1", "share_card", "moment:42")).toBeNull()
    expect(seen.p_ref).toBe("moment:42")
  })
})

describe("redeemItem", () => {
  it("returns an unauthorized shape for a missing userId without calling the RPC", async () => {
    const spy = vi.fn(async () => ({ data: { redeemed: true }, error: null }))
    state.rpc = spy
    expect(await redeemItem("", 5)).toEqual({ redeemed: false, error: "unauthorized" })
    expect(spy).not.toHaveBeenCalled()
  })

  it("maps params and returns the RPC payload on success", async () => {
    let seen: any = null
    state.rpc = async (_n, args) => {
      seen = args
      return { data: { redeemed: true, remaining: 3 }, error: null }
    }
    expect(await redeemItem("u1", 7)).toEqual({ redeemed: true, remaining: 3 })
    expect(seen).toEqual({ p_user_id: "u1", p_item_id: 7 })
  })

  it("returns a server_error shape on RPC error", async () => {
    state.rpc = async () => ({ data: null, error: { message: "stock" } })
    expect(await redeemItem("u1", 7)).toEqual({ redeemed: false, error: "server_error" })
  })
})

describe("getRewardsSummary", () => {
  it("returns null for a missing userId without calling the RPC", async () => {
    const spy = vi.fn(async () => ({ data: {}, error: null }))
    state.rpc = spy
    expect(await getRewardsSummary("")).toBeNull()
    expect(spy).not.toHaveBeenCalled()
  })

  it("returns the summary payload verbatim (error is ignored)", async () => {
    let seen: any = null
    state.rpc = async (_n, args) => {
      seen = args
      return { data: { spendable: 120, status: 3, tier: "gold" }, error: null }
    }
    expect(await getRewardsSummary("u1")).toMatchObject({ spendable: 120, tier: "gold" })
    expect(seen).toEqual({ p_user_id: "u1" })
  })
})

describe("adminAdjust", () => {
  it("maps all five params and returns the payload on success", async () => {
    let seenName: any = null
    let seen: any = null
    state.rpc = async (name, args) => {
      seenName = name
      seen = args
      return { data: { ok: true, spendable: 500 }, error: null }
    }
    const out = await adminAdjust("u1", 100, 2, "seed")
    expect(seenName).toBe("admin_adjust_points")
    expect(seen).toEqual({
      p_user_id: "u1",
      p_delta: 100,
      p_status_delta: 2,
      p_reason: "seed",
      p_admin: "owner", // default admin label
    })
    expect(out).toEqual({ ok: true, spendable: 500 })
  })

  it("honors an explicit admin label", async () => {
    let seen: any = null
    state.rpc = async (_n, args) => {
      seen = args
      return { data: { ok: true }, error: null }
    }
    await adminAdjust("u1", -50, 0, "refund", "trevor")
    expect(seen.p_admin).toBe("trevor")
  })

  it("returns { ok:false, error } on RPC error", async () => {
    state.rpc = async () => ({ data: null, error: { message: "denied" } })
    expect(await adminAdjust("u1", 10, 0, "x")).toEqual({ ok: false, error: "denied" })
  })
})

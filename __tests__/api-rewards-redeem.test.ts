import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for POST /api/rewards/redeem.
// Cookie-session auth via requireUser (401 Response when unauthed). The user id
// is session-resolved; redeemItem() re-validates everything server-side. Pins:
// unauth → 401, invalid JSON → 400, non-integer itemId → 400, and a mocked
// redeem happy path (redeemed:true → 200) + a rejected redeem (→ 400).

const state: { user: any; result: any } = { user: { id: "u1" }, result: { redeemed: true } }

vi.mock("@/lib/auth/supabase-server", () => ({
  requireUser: async () => {
    if (!state.user)
      throw new Response(JSON.stringify({ error: "Authentication required" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      })
    return state.user
  },
}))
vi.mock("@/lib/rewards", () => ({
  redeemItem: async () => state.result,
}))

import { POST } from "@/app/api/rewards/redeem/route"

function req(opts: { body?: any; badJson?: boolean }) {
  return { json: async () => { if (opts.badJson) throw new Error("x"); return opts.body ?? {} } } as any
}

beforeEach(() => {
  state.user = { id: "u1" }
  state.result = { redeemed: true }
})

describe("POST /api/rewards/redeem", () => {
  it("401s when unauthenticated", async () => {
    state.user = null
    const res = await POST(req({ body: { itemId: 1 } }))
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe("Authentication required")
  })

  it("400s on an invalid JSON body", async () => {
    expect((await POST(req({ badJson: true }))).status).toBe(400)
  })

  it("400s on a non-integer itemId", async () => {
    const res = await POST(req({ body: { itemId: "abc" } }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("bad_item")
  })

  it("200s on a successful redeem", async () => {
    state.result = { redeemed: true, item: "sticker" }
    const res = await POST(req({ body: { itemId: 3 } }))
    expect(res.status).toBe(200)
    expect((await res.json()).redeemed).toBe(true)
  })

  it("400s when the redeem is rejected", async () => {
    state.result = { redeemed: false, error: "insufficient_balance" }
    const res = await POST(req({ body: { itemId: 3 } }))
    expect(res.status).toBe(400)
  })
})

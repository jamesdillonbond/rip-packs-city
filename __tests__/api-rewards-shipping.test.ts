import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for POST /api/rewards/shipping.
// Cookie-session auth via requireUser (401 Response when unauthed). Attaches a
// shipping address (merch) OR a giftTo username (moment) to a PENDING redemption
// the user owns. Pins the pre-DB guards (unauth 401, invalid JSON 400,
// bad_redemption 400, exactly-one-of address/giftTo 400, bad_address 400) and a
// mocked owned-pending-merch address happy path (→ 200) via the @/lib/supabase
// builder seam.

const state: {
  user: any
  red: { data: any; error: any }
  up: { error: any }
} = { user: { id: "u1" }, red: { data: null, error: null }, up: { error: null } }

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
vi.mock("@/lib/supabase", () => {
  const b: any = {
    from: () => b,
    select: () => b,
    update: () => b,
    eq: () => b,
    maybeSingle: async () => state.red,
    then: (resolve: any) => resolve(state.up),
  }
  return { supabaseAdmin: b }
})

import { POST } from "@/app/api/rewards/shipping/route"

function req(opts: { body?: any; badJson?: boolean }) {
  return { json: async () => { if (opts.badJson) throw new Error("x"); return opts.body ?? {} } } as any
}

const goodAddress = { name: "Trevor", line1: "1 Main St", city: "Portland" }

beforeEach(() => {
  state.user = { id: "u1" }
  state.red = { data: null, error: null }
  state.up = { error: null }
})

describe("POST /api/rewards/shipping", () => {
  it("401s when unauthenticated", async () => {
    state.user = null
    const res = await POST(req({ body: { redemptionId: 1, address: goodAddress } }))
    expect(res.status).toBe(401)
  })

  it("400s on an invalid JSON body", async () => {
    expect((await POST(req({ badJson: true }))).status).toBe(400)
  })

  it("400s on a non-integer redemptionId", async () => {
    const res = await POST(req({ body: { redemptionId: "x", address: goodAddress } }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("bad_redemption")
  })

  it("400s when neither address nor giftTo is provided", async () => {
    const res = await POST(req({ body: { redemptionId: 1 } }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("provide_address_or_giftTo")
  })

  it("400s when both address and giftTo are provided", async () => {
    const res = await POST(
      req({ body: { redemptionId: 1, address: goodAddress, giftTo: "@collector" } })
    )
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("provide_address_or_giftTo")
  })

  it("400s on an unusable address", async () => {
    const res = await POST(req({ body: { redemptionId: 1, address: { name: "x" } } }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("bad_address")
  })

  it("attaches a valid address to an owned pending merch redemption", async () => {
    state.red = {
      data: { id: 1, user_id: "u1", status: "pending", fulfillment: null, shop_items: { type: "merch" } },
      error: null,
    }
    const res = await POST(req({ body: { redemptionId: 1, address: goodAddress } }))
    expect(res.status).toBe(200)
    expect((await res.json()).ok).toBe(true)
  })
})

import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for POST /api/rewards/equip.
// Cookie-session auth via requireUser (throws a 401 Response when unauthed);
// ownership is re-verified against user_cosmetics, slot/value read from the
// OWNED row (never the body). Pins: unauth → 401, invalid JSON → 400, empty sku
// → 400, not-owned → 403, and a mocked owned+upsert happy path.

const state: {
  user: any
  owned: { data: any; error: any }
  up: { error: any }
} = { user: { id: "u1" }, owned: { data: null, error: null }, up: { error: null } }

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
    eq: () => b,
    maybeSingle: async () => state.owned,
    upsert: async () => state.up,
  }
  return { supabaseAdmin: b }
})

import { POST } from "@/app/api/rewards/equip/route"

function req(opts: { body?: any; badJson?: boolean }) {
  return { json: async () => { if (opts.badJson) throw new Error("x"); return opts.body ?? {} } } as any
}

beforeEach(() => {
  state.user = { id: "u1" }
  state.owned = { data: null, error: null }
  state.up = { error: null }
})

describe("POST /api/rewards/equip", () => {
  it("401s when unauthenticated", async () => {
    state.user = null
    const res = await POST(req({ body: { sku: "x" } }))
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe("Authentication required")
  })

  it("400s on an invalid JSON body", async () => {
    expect((await POST(req({ badJson: true }))).status).toBe(400)
  })

  it("400s on an empty sku", async () => {
    const res = await POST(req({ body: {} }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("bad_sku")
  })

  it("403s when the cosmetic is not owned", async () => {
    state.owned = { data: null, error: null }
    const res = await POST(req({ body: { sku: "border_gold" } }))
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe("not_owned")
  })

  it("equips an owned border cosmetic", async () => {
    state.owned = { data: { slot: "border", value: "gold" }, error: null }
    const res = await POST(req({ body: { sku: "border_gold" } }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ ok: true, slot: "border", value: "gold" })
  })
})

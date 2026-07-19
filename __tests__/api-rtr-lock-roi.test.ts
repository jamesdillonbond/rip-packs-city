import { describe, it, expect, beforeEach, vi } from "vitest"
import { NextRequest } from "next/server"

// Route integration test for POST /api/rtr/lock-roi. requireUser-gated
// (fail-closed 401), then a zod body guard (malformed_json 400, invalid_body
// 400 for a bad walletAddr). Happy path: an authed user + valid wallet whose
// wallet_moments_cache is empty short-circuits to the empty payload before any
// editions/fmv lookup — the simplest mock seam. supabaseAdmin (@/lib/supabase)
// is a chainable builder resolving to state.wmc.

const state: { user: any; wmc: any } = { user: null, wmc: { data: [], error: null } }

vi.mock("@/lib/supabase", () => {
  const b: any = {
    select: () => b,
    eq: () => b,
    in: () => b,
    order: () => b,
    range: () => b,
    then: (resolve: any) => resolve(state.wmc),
  }
  const admin: any = { from: () => b }
  return { supabaseAdmin: admin, supabase: admin }
})

vi.mock("@/lib/auth/supabase-server", () => ({
  requireUser: async () => {
    if (!state.user)
      throw new Response(JSON.stringify({ error: "Authentication required" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      })
    return state.user
  },
  getCurrentUser: async () => state.user,
}))

import { POST } from "@/app/api/rtr/lock-roi/route"

function post(body: string): NextRequest {
  return new NextRequest("https://t/api/rtr/lock-roi", {
    method: "POST",
    headers: new Headers({ "content-type": "application/json" }),
    body,
  })
}

beforeEach(() => {
  state.user = null
  state.wmc = { data: [], error: null }
})

describe("POST /api/rtr/lock-roi", () => {
  it("401s when unauthenticated", async () => {
    state.user = null
    const res = await POST(post(JSON.stringify({ walletAddr: "0x0000000000000001" })))
    expect(res.status).toBe(401)
  })

  it("400s on malformed JSON", async () => {
    state.user = { id: "u1" }
    const res = await POST(post("{not-json"))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("malformed_json")
  })

  it("400s invalid_body on a bad walletAddr", async () => {
    state.user = { id: "u1" }
    const res = await POST(post(JSON.stringify({ walletAddr: "nope" })))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("invalid_body")
  })

  it("returns the empty payload for an authed user with no cached moments", async () => {
    state.user = { id: "u1" }
    state.wmc = { data: [], error: null }
    const res = await POST(post(JSON.stringify({ walletAddr: "0x00000000000000Ab" })))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.walletAddr).toBe("0x00000000000000ab") // lower-cased
    expect(body.rowCount).toBe(0)
    expect(body.totalAvailable).toBe(0)
    expect(body.moments).toEqual([])
  })

  it("exports a POST function", () => {
    expect(typeof POST).toBe("function")
  })
})

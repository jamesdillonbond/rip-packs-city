import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for /api/profile/trophy. GET/POST/DELETE are all
// requireUser-gated (fail-closed 401). Pins the 401s, the POST param 400s
// (slot+momentId required; slot must be 1..6), the DELETE 400, and a mocked
// GET happy path.

const state: { user: any; result: any } = {
  user: null,
  result: { data: [], error: null },
}

vi.mock("@/lib/supabase", () => {
  const build = () => {
    const b: any = {
      select: () => b, upsert: () => b, delete: () => b, eq: () => b, order: () => b,
      single: async () => state.result,
      then: (resolve: any) => resolve(state.result),
    }
    return b
  }
  const client: any = { from: () => build(), rpc: async () => state.result }
  return { supabase: client, supabaseAdmin: client }
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

import { GET, POST, DELETE } from "@/app/api/profile/trophy/route"

const req = (body?: any) => ({ json: async () => body }) as any

beforeEach(() => {
  state.user = null
  state.result = { data: [], error: null }
})

describe("/api/profile/trophy", () => {
  it("GET 401s when unauthenticated (fail-closed)", async () => {
    expect((await GET()).status).toBe(401)
  })

  it("POST 401s when unauthenticated (fail-closed)", async () => {
    expect((await POST(req({ slot: 1, momentId: "m1" }))).status).toBe(401)
  })

  it("POST 400s without slot/momentId", async () => {
    state.user = { id: "u1" }
    const res = await POST(req({}))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("slot and momentId required")
  })

  it("POST 400s when slot is out of range", async () => {
    state.user = { id: "u1" }
    const res = await POST(req({ slot: 9, momentId: "m1" }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("slot must be between 1 and 6")
  })

  it("DELETE 400s without slot", async () => {
    state.user = { id: "u1" }
    expect((await DELETE(req({}))).status).toBe(400)
  })

  it("GET returns the user's trophies on the happy path", async () => {
    state.user = { id: "u1" }
    state.result = { data: [{ slot: 1, moment_id: "m1" }], error: null }
    const res = await GET()
    expect(res.status).toBe(200)
    expect((await res.json()).trophies).toHaveLength(1)
  })
})

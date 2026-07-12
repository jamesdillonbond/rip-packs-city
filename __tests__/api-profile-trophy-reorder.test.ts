import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for /api/profile/trophy/reorder (POST only).
// requireUser-gated (fail-closed 401) then a strict orderedIds validator. Pins
// the 401, the invalid-JSON/empty/too-many/non-integer/duplicate 400s, the RPC
// happy path, and the stale-client 409 (reorder RPC mismatch → 409).

const state: { user: any; rpcError: any } = { user: null, rpcError: null }

vi.mock("@/lib/supabase", () => ({
  supabase: { rpc: async () => ({ error: state.rpcError }) },
  supabaseAdmin: { rpc: async () => ({ error: state.rpcError }) },
}))

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

import { POST } from "@/app/api/profile/trophy/reorder/route"

const req = (body?: any, throws = false) =>
  ({
    json: async () => {
      if (throws) throw new Error("bad json")
      return body
    },
  }) as any

beforeEach(() => {
  state.user = null
  state.rpcError = null
})

describe("POST /api/profile/trophy/reorder", () => {
  it("401s when unauthenticated (fail-closed)", async () => {
    expect((await POST(req({ orderedIds: [1] }))).status).toBe(401)
  })

  it("400s on invalid JSON body", async () => {
    state.user = { id: "u1" }
    expect((await POST(req(undefined, true))).status).toBe(400)
  })

  it("400s when orderedIds is empty or not an array", async () => {
    state.user = { id: "u1" }
    expect((await POST(req({ orderedIds: [] }))).status).toBe(400)
    expect((await POST(req({ orderedIds: "no" }))).status).toBe(400)
  })

  it("400s when there are more than 6 slots", async () => {
    state.user = { id: "u1" }
    expect((await POST(req({ orderedIds: [1, 2, 3, 4, 5, 6, 7] }))).status).toBe(400)
  })

  it("400s on non-positive-integer ids and on duplicate ids", async () => {
    state.user = { id: "u1" }
    expect((await POST(req({ orderedIds: [1, 0] }))).status).toBe(400)
    expect((await POST(req({ orderedIds: [1, 1] }))).status).toBe(400)
  })

  it("returns ok on a valid reorder", async () => {
    state.user = { id: "u1" }
    const res = await POST(req({ orderedIds: [3, 1, 2] }))
    expect(res.status).toBe(200)
    expect((await res.json()).ok).toBe(true)
  })

  it("409s when the reorder RPC reports a stale-client mismatch", async () => {
    state.user = { id: "u1" }
    state.rpcError = { message: "ownership mismatch" }
    expect((await POST(req({ orderedIds: [1, 2] }))).status).toBe(409)
  })
})

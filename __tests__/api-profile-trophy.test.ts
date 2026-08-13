import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for /api/profile/trophy. GET/POST/DELETE are all
// requireUser-gated (fail-closed 401). Pins the 401s, the POST param 400s
// (slot+momentId required; slot must be 1..6), the DELETE 400, the GET happy
// path, AND (2026-07-28 Gap-C+ pass) the previously-dark legs: every 500 error
// branch, the POST upsert success incl. the NBA-Top-Shot collection_id default
// + pinned_at stamp, and the DELETE success.

const state: { user: any; result: any; lastUpsert: any } = {
  user: null,
  result: { data: [], error: null },
  lastUpsert: null,
}

vi.mock("@/lib/supabase", () => {
  const build = () => {
    const b: any = {
      select: () => b,
      upsert: (payload: any) => {
        state.lastUpsert = payload
        return b
      },
      delete: () => b,
      eq: () => b,
      order: () => b,
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
  state.lastUpsert = null
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

  it("GET 500s on a read error", async () => {
    state.user = { id: "u1" }
    state.result = { data: null, error: { message: "read boom" } }
    const res = await GET()
    expect(res.status).toBe(500)
    expect((await res.json()).error).not.toContain("read boom")
  })

  it("POST upserts with the NBA-Top-Shot collection default + pinned_at, returns the trophy", async () => {
    state.user = { id: "u1" }
    state.result = { data: { slot: 2, moment_id: "m2" }, error: null }
    const res = await POST(req({ slot: 2, momentId: "m2" }))
    expect(res.status).toBe(200)
    expect((await res.json()).trophy).toMatchObject({ slot: 2 })
    // collection default applied, user pinned from the session, pinned_at stamped
    expect(state.lastUpsert.collection_id).toBe("95f28a17-224a-4025-96ad-adf8a4c63bfd")
    expect(state.lastUpsert.user_id).toBe("u1")
    expect(typeof state.lastUpsert.pinned_at).toBe("string")
    // optional fields default to null, not undefined
    expect(state.lastUpsert.edition_id).toBeNull()
    expect(state.lastUpsert.note).toBeNull()
  })

  it("POST honors an explicit collectionId", async () => {
    state.user = { id: "u1" }
    state.result = { data: { slot: 3 }, error: null }
    await POST(req({ slot: 3, momentId: "m3", collectionId: "col-x" }))
    expect(state.lastUpsert.collection_id).toBe("col-x")
  })

  it("POST 500s on an upsert error", async () => {
    state.user = { id: "u1" }
    state.result = { data: null, error: { message: "upsert boom" } }
    const res = await POST(req({ slot: 1, momentId: "m1" }))
    expect(res.status).toBe(500)
    expect((await res.json()).error).not.toContain("upsert boom")
  })

  it("DELETE removes a slot and returns ok on success", async () => {
    state.user = { id: "u1" }
    state.result = { error: null }
    const res = await DELETE(req({ slot: 4 }))
    expect(res.status).toBe(200)
    expect((await res.json()).ok).toBe(true)
  })

  it("DELETE 500s on a delete error", async () => {
    state.user = { id: "u1" }
    state.result = { error: { message: "delete boom" } }
    const res = await DELETE(req({ slot: 4 }))
    expect(res.status).toBe(500)
    expect((await res.json()).error).not.toContain("delete boom")
  })
})

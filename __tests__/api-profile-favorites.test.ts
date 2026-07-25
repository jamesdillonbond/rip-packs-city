import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for /api/profile/favorites (GET/POST/DELETE, all
// requireUser()-gated). Legs pinned: the fail-closed 401 on every verb, the GET
// list + its 500, POST param-400 / upsert success / upsert 500, and DELETE
// param-400 / success / 500. The supabase mock dispatches on the operation so the
// awaited select chain, the .upsert().select().single(), and the awaited delete
// chain each resolve independently.

const state: {
  user: any
  list: { data: any; error: any }
  upserted: { data: any; error: any }
  deleted: { error: any }
} = {
  user: null,
  list: { data: [], error: null },
  upserted: { data: { collection_id: "c1", favorited: true }, error: null },
  deleted: { error: null },
}

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from() {
      let op: "select" | "upsert" | "delete" = "select"
      const b: any = {
        select: () => b,
        upsert: () => { op = "upsert"; return b },
        delete: () => { op = "delete"; return b },
        eq: () => b,
        order: () => b,
        single: async () => state.upserted,
        then: (resolve: any) => resolve(op === "delete" ? state.deleted : state.list),
      }
      return b
    },
  },
}))

vi.mock("@/lib/auth/supabase-server", () => ({
  requireUser: async () => {
    if (!state.user) {
      throw new Response(JSON.stringify({ error: "Authentication required" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      })
    }
    return state.user
  },
  getCurrentUser: async () => state.user,
}))

import { GET, POST, DELETE } from "@/app/api/profile/favorites/route"

const preq = (body: any) => ({ json: async () => body }) as any

beforeEach(() => {
  state.user = null
  state.list = { data: [], error: null }
  state.upserted = { data: { collection_id: "c1", favorited: true }, error: null }
  state.deleted = { error: null }
})

describe("/api/profile/favorites — auth", () => {
  it("GET 401s when unauthenticated (fail-closed)", async () => {
    const res = await GET()
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe("Authentication required")
  })
  it("POST 401s when unauthenticated", async () => {
    expect((await POST(preq({ collectionId: "c1" }))).status).toBe(401)
  })
  it("DELETE 401s when unauthenticated", async () => {
    expect((await DELETE(preq({ collectionId: "c1" }))).status).toBe(401)
  })
})

describe("GET /api/profile/favorites", () => {
  it("returns the favorited collections for an authed user", async () => {
    state.user = { id: "u1" }
    state.list = { data: [{ collection_id: "c1", favorited: true }], error: null }
    const body = await (await GET()).json()
    expect(body.favorites).toHaveLength(1)
  })
  it("defaults to an empty list when the query returns null data", async () => {
    state.user = { id: "u1" }
    state.list = { data: null, error: null }
    expect((await (await GET()).json()).favorites).toEqual([])
  })
  it("500s on a select error", async () => {
    state.user = { id: "u1" }
    state.list = { data: null, error: { message: "prefs down" } }
    const res = await GET()
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("prefs down")
  })
})

describe("POST /api/profile/favorites", () => {
  it("400s when collectionId is missing", async () => {
    state.user = { id: "u1" }
    const res = await POST(preq({}))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("collectionId required")
  })
  it("upserts the favorite and returns the row", async () => {
    state.user = { id: "u1" }
    const body = await (await POST(preq({ collectionId: "c1" }))).json()
    expect(body.favorite.collection_id).toBe("c1")
    expect(body.favorite.favorited).toBe(true)
  })
  it("500s on an upsert error", async () => {
    state.user = { id: "u1" }
    state.upserted = { data: null, error: { message: "upsert down" } }
    expect((await POST(preq({ collectionId: "c1" }))).status).toBe(500)
  })
})

describe("DELETE /api/profile/favorites", () => {
  it("400s when collectionId is missing", async () => {
    state.user = { id: "u1" }
    const res = await DELETE(preq({}))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("collectionId required")
  })
  it("unfavorites and returns ok", async () => {
    state.user = { id: "u1" }
    expect(await (await DELETE(preq({ collectionId: "c1" }))).json()).toEqual({ ok: true })
  })
  it("500s on a delete error", async () => {
    state.user = { id: "u1" }
    state.deleted = { error: { message: "delete down" } }
    expect((await DELETE(preq({ collectionId: "c1" }))).status).toBe(500)
  })
})

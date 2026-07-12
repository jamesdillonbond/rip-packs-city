import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for /api/profile/favorites.
// GET/POST/DELETE are all requireUser()-gated → 401 unauthenticated. Pin the
// fail-closed 401 on GET, the authed GET happy path, and POST param-400 when
// collectionId is missing for an authed user.

const state: { user: any; favorites: { data: any; error: any } } = {
  user: null,
  favorites: { data: [], error: null },
}

function chain(getResult: () => any): any {
  const b: any = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "then") return (res: any, rej: any) => Promise.resolve(getResult()).then(res, rej)
        return () => b
      },
    }
  )
  return b
}

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: { from: () => chain(() => state.favorites) },
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

import { GET, POST } from "@/app/api/profile/favorites/route"

const preq = (body: any) => ({ json: async () => body }) as any

beforeEach(() => {
  state.user = null
  state.favorites = { data: [], error: null }
})

describe("/api/profile/favorites", () => {
  it("GET 401s when unauthenticated (fail-closed)", async () => {
    state.user = null
    const res = await GET()
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe("Authentication required")
  })

  it("GET returns the favorited collections for an authed user", async () => {
    state.user = { id: "u1" }
    state.favorites = { data: [{ collection_id: "c1", favorited: true }], error: null }
    const res = await GET()
    expect(res.status).toBe(200)
    expect((await res.json()).favorites).toHaveLength(1)
  })

  it("POST 400s when collectionId is missing for an authed user", async () => {
    state.user = { id: "u1" }
    const res = await POST(preq({}))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("collectionId required")
  })

  it("POST 401s when unauthenticated", async () => {
    state.user = null
    const res = await POST(preq({ collectionId: "c1" }))
    expect(res.status).toBe(401)
  })
})

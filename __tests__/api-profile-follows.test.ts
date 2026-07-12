import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for /api/profile/follows.
// GET/POST/DELETE are requireUser()-gated → 401 unauthenticated. Pin the
// fail-closed 401 on GET, the authed GET happy path (follows edges [] → []),
// and the POST param-400 when username is missing.

const state: { user: any; follows: { data: any; error: any } } = {
  user: null,
  follows: { data: [], error: null },
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
  supabaseAdmin: { from: () => chain(() => state.follows) },
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

import { GET, POST } from "@/app/api/profile/follows/route"

const preq = (body: any) => ({ json: async () => body }) as any

beforeEach(() => {
  state.user = null
  state.follows = { data: [], error: null }
})

describe("/api/profile/follows", () => {
  it("GET 401s when unauthenticated (fail-closed)", async () => {
    state.user = null
    const res = await GET()
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe("Authentication required")
  })

  it("GET returns an empty list when the user follows nobody", async () => {
    state.user = { id: "u1" }
    state.follows = { data: [], error: null }
    const res = await GET()
    expect(res.status).toBe(200)
    expect((await res.json()).follows).toEqual([])
  })

  it("GET 500s when the follows query errors", async () => {
    state.user = { id: "u1" }
    state.follows = { data: null, error: { message: "db" } }
    expect((await GET()).status).toBe(500)
  })

  it("POST 400s when username is missing for an authed user", async () => {
    state.user = { id: "u1" }
    const res = await POST(preq({}))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("username required")
  })
})

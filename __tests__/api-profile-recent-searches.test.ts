import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for /api/profile/recent-searches. requireUser-gated
// (throws a 401 Response caught by the handler). Pins the fail-closed 401 on
// GET/POST, the POST param 400 (query required), and a mocked GET happy path.

const state: { user: any; result: any; single: any } = {
  user: null,
  result: { data: [], error: null },
  single: { data: null, error: null },
}

vi.mock("@/lib/supabase", () => {
  const build = () => {
    const b: any = {
      select: () => b, insert: () => b, update: () => b, upsert: () => b,
      delete: () => b, eq: () => b, gt: () => b, like: () => b, ilike: () => b,
      or: () => b, is: () => b, in: () => b, order: () => b, limit: () => b,
      single: async () => state.single,
      maybeSingle: async () => state.single,
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

import { GET, POST } from "@/app/api/profile/recent-searches/route"

const req = (url: string, body?: any) =>
  ({ nextUrl: new URL(url), json: async () => body }) as any

beforeEach(() => {
  state.user = null
  state.result = { data: [], error: null }
  state.single = { data: null, error: null }
})

describe("/api/profile/recent-searches", () => {
  it("GET 401s when unauthenticated (fail-closed)", async () => {
    expect((await GET()).status).toBe(401)
  })

  it("POST 401s when unauthenticated (fail-closed)", async () => {
    const res = await POST(req("https://t/api/profile/recent-searches", { query: "x" }))
    expect(res.status).toBe(401)
  })

  it("POST 400s without query for an authed user", async () => {
    state.user = { id: "u1" }
    const res = await POST(req("https://t/api/profile/recent-searches", {}))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("query required")
  })

  it("GET returns the user's searches on the happy path", async () => {
    state.user = { id: "u1" }
    state.result = { data: [{ id: 1, query: "lebron" }], error: null }
    const res = await GET()
    expect(res.status).toBe(200)
    expect((await res.json()).searches).toHaveLength(1)
  })
})

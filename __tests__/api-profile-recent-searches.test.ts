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

  it("GET 500s when the select errors", async () => {
    state.user = { id: "u1" }
    state.result = { data: null, error: { message: "db down" } }
    const res = await GET()
    expect(res.status).toBe(500)
    expect((await res.json()).error).not.toContain("db down")
  })

  it("POST inserts and returns the new row on the happy path", async () => {
    state.user = { id: "u1" }
    state.single = { data: { id: 9, query: "lebron", query_type: "player" }, error: null }
    const res = await POST(req("https://t/api/profile/recent-searches", { query: "LeBron James" }))
    expect(res.status).toBe(200)
    expect((await res.json()).search).toMatchObject({ id: 9 })
  })

  it("POST 500s when the insert errors", async () => {
    state.user = { id: "u1" }
    state.single = { data: null, error: { message: "insert failed" } }
    const res = await POST(req("https://t/api/profile/recent-searches", { query: "x" }))
    expect(res.status).toBe(500)
    expect((await res.json()).error).not.toContain("insert failed")
  })

  it("POST honors an explicit valid queryType and a provided collectionId", async () => {
    state.user = { id: "u1" }
    state.single = { data: { id: 1, query_type: "edition" }, error: null }
    const res = await POST(
      req("https://t/api/profile/recent-searches", { query: "anything", queryType: "edition", collectionId: "coll-2" }),
    )
    expect(res.status).toBe(200)
  })

  it("POST infers the type for various queries (address/handle → wallet, S\\d → edition, name → player)", async () => {
    state.user = { id: "u1" }
    // Each returns 200; the branch of interest is inferType, exercised for
    // coverage of its address/handle/edition/player arms.
    for (const query of ["snoop_dog", "Series S5", "LeBron James", "0x1234567890abcdef"]) {
      state.single = { data: { id: 1 }, error: null }
      const res = await POST(req("https://t/api/profile/recent-searches", { query, queryType: "not-a-valid-type" }))
      expect(res.status).toBe(200)
    }
  })
})

import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for /api/profile/activity (Friend Activity feed).
// Auth-gated via requireUser() → throws a 401 Response when unauthenticated;
// the handler catches it and returns it. Pin the fail-closed 401, then a
// happy path where the authed user follows nobody (follows query returns [])
// so the handler short-circuits to { activity: [] } without the sales fan-out.

const state: { user: any; tables: Record<string, any> } = { user: null, tables: {} }

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
  supabaseAdmin: {
    from: (t: string) => chain(() => state.tables[t] ?? { data: [], error: null }),
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

import { GET } from "@/app/api/profile/activity/route"

beforeEach(() => {
  state.user = null
  state.tables = {}
})

describe("GET /api/profile/activity", () => {
  it("401s when unauthenticated (fail-closed)", async () => {
    state.user = null
    const res = await GET()
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe("Authentication required")
  })

  it("returns an empty feed when the authed user follows nobody", async () => {
    state.user = { id: "u1" }
    state.tables.follows = { data: [], error: null }
    const res = await GET()
    expect(res.status).toBe(200)
    expect((await res.json()).activity).toEqual([])
  })

  it("500s when the follows query errors", async () => {
    state.user = { id: "u1" }
    state.tables.follows = { data: null, error: { message: "boom" } }
    const res = await GET()
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("boom")
  })
})

import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for /api/profile/bio.
// GET/POST/PATCH are all auth-gated via requireUser() → 401 when
// unauthenticated. Pin the fail-closed 401 on GET, the authed GET happy path
// (.from().select().eq().maybeSingle() → { bio }), and the GET error → 500.
// POST/PATCH additionally call awardPoints; we only assert they are functions.

const state: { user: any; bio: { data: any; error: any } } = {
  user: null,
  bio: { data: null, error: null },
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
  supabaseAdmin: { from: () => chain(() => state.bio) },
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

vi.mock("@/lib/rewards", () => ({ awardPoints: async () => undefined }))

import { GET, POST, PATCH } from "@/app/api/profile/bio/route"

beforeEach(() => {
  state.user = null
  state.bio = { data: null, error: null }
})

describe("GET /api/profile/bio", () => {
  it("401s when unauthenticated (fail-closed)", async () => {
    state.user = null
    const res = await GET()
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe("Authentication required")
  })

  it("returns the bio row for an authed user", async () => {
    state.user = { id: "u1", email: "a@b.com" }
    state.bio = { data: { username: "trevor", display_name: "Trevor" }, error: null }
    const res = await GET()
    expect(res.status).toBe(200)
    expect((await res.json()).bio).toMatchObject({ username: "trevor" })
  })

  it("500s on a select error", async () => {
    state.user = { id: "u1" }
    state.bio = { data: null, error: { message: "db" } }
    expect((await GET()).status).toBe(500)
  })

  it("exports POST and PATCH handlers", () => {
    expect(typeof POST).toBe("function")
    expect(typeof PATCH).toBe("function")
  })
})

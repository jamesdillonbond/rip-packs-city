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

const awardPoints = vi.fn(async () => undefined)
vi.mock("@/lib/rewards", () => ({ awardPoints: (...a: any[]) => (awardPoints as any)(...a) }))

import { GET, POST, PATCH } from "@/app/api/profile/bio/route"

const jsonReq = (body: any): any => ({ json: async () => body })
const badJsonReq = (): any => ({ json: async () => { throw new Error("bad") } })

beforeEach(() => {
  state.user = null
  state.bio = { data: null, error: null }
  awardPoints.mockClear()
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

describe("POST /api/profile/bio", () => {
  it("401s when unauthenticated", async () => {
    const res = await POST(jsonReq({ username: "x" }))
    expect(res.status).toBe(401)
  })

  it("upserts the bio and awards complete_profile on save", async () => {
    state.user = { id: "u1", email: "trevor@example.com" }
    state.bio = { data: { username: "trevor", display_name: "Trevor" }, error: null }
    const res = await POST(jsonReq({ username: "trevor", displayName: "Trevor" }))
    expect(res.status).toBe(200)
    expect((await res.json()).bio).toMatchObject({ username: "trevor" })
    expect(awardPoints).toHaveBeenCalledWith("u1", "complete_profile")
  })

  it("defaults username from the email local-part when none supplied", async () => {
    // TDillon+tag@Gmail.com → local-part "tdillon+tag" → lowercased, non-[a-z0-9_-] stripped → "tdillontag"
    state.user = { id: "u2", email: "TDillon+tag@Gmail.com" }
    state.bio = { data: { username: "tdillontag" }, error: null }
    const res = await POST(jsonReq({}))
    expect(res.status).toBe(200)
    expect((await res.json()).bio.username).toBe("tdillontag")
    expect(awardPoints).toHaveBeenCalled()
  })

  it("500s on an upsert error", async () => {
    state.user = { id: "u1", email: "a@b.com" }
    state.bio = { data: null, error: { message: "conflict" } }
    const res = await POST(jsonReq({ username: "x" }))
    expect(res.status).toBe(500)
    // a failed save must NOT award points
    expect(awardPoints).not.toHaveBeenCalled()
  })
})

describe("PATCH /api/profile/bio", () => {
  it("401s when unauthenticated", async () => {
    expect((await PATCH(jsonReq({ displayName: "x" }))).status).toBe(401)
  })

  it("400s on invalid JSON", async () => {
    state.user = { id: "u1" }
    const res = await PATCH(badJsonReq())
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("Invalid JSON body")
  })

  it("400s when no updatable field is supplied", async () => {
    state.user = { id: "u1" }
    const res = await PATCH(jsonReq({ unknownField: 1 }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("No updatable fields supplied")
  })

  it("updates a supplied field and returns the row", async () => {
    state.user = { id: "u1" }
    state.bio = { data: { display_name: "New Name" }, error: null }
    const res = await PATCH(jsonReq({ displayName: "New Name" }))
    expect(res.status).toBe(200)
    expect((await res.json()).bio).toMatchObject({ display_name: "New Name" })
  })

  it("accepts a null heroMomentId as a clear (present-key branch)", async () => {
    state.user = { id: "u1" }
    state.bio = { data: { hero_moment_id: null }, error: null }
    const res = await PATCH(jsonReq({ heroMomentId: null }))
    expect(res.status).toBe(200)
  })

  it("500s on an upsert error", async () => {
    state.user = { id: "u1" }
    state.bio = { data: null, error: { message: "db" } }
    expect((await PATCH(jsonReq({ tagline: "hi" }))).status).toBe(500)
  })
})

import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for /api/profile/follows (follow/unfollow by username).
// requireUser()-gated → 401 unauthenticated. Beyond the fail-closed 401s + param
// 400s, this covers the GET enrichment (bio join + accent_color default), the
// GET ?username= single-edge probe (anon → authed:false not 401, self, hit,
// miss, error), and the POST/DELETE resolve→guard→write flows: user-not-found
// 404, self-follow 400, write success, and write error 500. The mock resolves
// `follows` reads/writes via `then` and `profile_bio` username-resolution via
// `maybeSingle`; `maybeSingle` is table-AWARE because the probe calls it on
// `follows` too, and a shared stub would answer the edge lookup with the
// username-resolution row.

const state: {
  user: any
  followsResult: { data: any; error: any }
  bioList: { data: any; error: any }
  resolveBio: { data: any } // profile_bio.maybeSingle → { user_id }
  probeEdge: { data: any; error: any } // follows.maybeSingle → the edge or null
} = {
  user: null,
  followsResult: { data: [], error: null },
  bioList: { data: [], error: null },
  resolveBio: { data: null },
  probeEdge: { data: null, error: null },
}

vi.mock("@/lib/supabase", () => {
  const chainFor = (table: string) => {
    const b: any = {
      select: () => b, eq: () => b, in: () => b, order: () => b, ilike: () => b,
      upsert: () => b, delete: () => b,
      maybeSingle: async () => (table === "follows" ? state.probeEdge : state.resolveBio),
      then: (resolve: any) => resolve(table === "follows" ? state.followsResult : state.bioList),
    }
    return b
  }
  return { supabaseAdmin: { from: (t: string) => chainFor(t) } }
})

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

import { GET, POST, DELETE } from "@/app/api/profile/follows/route"

const preq = (body: any) => ({ json: async () => body }) as any
// GET now reads req.nextUrl.searchParams to detect the ?username= probe, so
// every GET call needs a request. `qs` is the raw query string ("" = listing).
const greq = (qs = "") =>
  ({ nextUrl: new URL("http://localhost/api/profile/follows" + qs) }) as any

beforeEach(() => {
  state.user = null
  state.followsResult = { data: [], error: null }
  state.bioList = { data: [], error: null }
  state.resolveBio = { data: null }
  state.probeEdge = { data: null, error: null }
})

describe("GET /api/profile/follows", () => {
  it("401s when unauthenticated (fail-closed)", async () => {
    const res = await GET(greq())
    expect(res.status).toBe(401)
  })

  it("returns an empty list when the user follows nobody", async () => {
    state.user = { id: "u1" }
    const res = await GET(greq())
    expect(res.status).toBe(200)
    expect((await res.json()).follows).toEqual([])
  })

  it("500s when the follows query errors", async () => {
    state.user = { id: "u1" }
    state.followsResult = { data: null, error: { message: "db" } }
    expect((await GET(greq())).status).toBe(500)
  })

  it("enriches each edge with the followee bio and defaults accent_color", async () => {
    state.user = { id: "u1" }
    state.followsResult = {
      data: [
        { followee_user_id: "u2", created_at: "2026-07-02" },
        { followee_user_id: "u3", created_at: "2026-07-01" }, // no bio → null fields + default accent
      ],
      error: null,
    }
    state.bioList = {
      data: [{ user_id: "u2", username: "friend", display_name: "Friend", avatar_url: "http://a", accent_color: "#123456" }],
      error: null,
    }
    const res = await GET(greq())
    const { follows } = await res.json()
    expect(follows).toHaveLength(2)
    expect(follows[0]).toMatchObject({ user_id: "u2", username: "friend", accent_color: "#123456" })
    // u3 has no bio row → null identity + the brand-red default accent
    expect(follows[1]).toMatchObject({ user_id: "u3", username: null, accent_color: "#E03A2F" })
  })
})

describe("GET /api/profile/follows?username= (single-edge probe)", () => {
  // The probe backs a button on an anon-readable ISR page. Anon must NOT 401 —
  // the button needs to distinguish "signed out" (render a sign-in CTA) from
  // "request failed", and a 401 collapses those.
  it("returns authed:false rather than 401 for anon", async () => {
    const res = await GET(greq("?username=friend"))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ authed: false, following: false })
  })

  it("never caches — follow state is per-viewer on an ISR page", async () => {
    const res = await GET(greq("?username=friend"))
    expect(res.headers.get("Cache-Control")).toBe("no-store")
  })

  it("reports self:true when probing your own profile", async () => {
    state.user = { id: "u1" }
    state.resolveBio = { data: { user_id: "u1" } }
    const res = await GET(greq("?username=me"))
    expect(await res.json()).toEqual({ authed: true, following: false, self: true })
  })

  it("reports following:true when the edge exists", async () => {
    state.user = { id: "u1" }
    state.resolveBio = { data: { user_id: "u2" } }
    state.probeEdge = { data: { followee_user_id: "u2" }, error: null }
    const res = await GET(greq("?username=friend"))
    expect(await res.json()).toEqual({ authed: true, following: true, self: false })
  })

  it("reports following:false when no edge exists", async () => {
    state.user = { id: "u1" }
    state.resolveBio = { data: { user_id: "u2" } }
    state.probeEdge = { data: null, error: null }
    const res = await GET(greq("?username=friend"))
    expect(await res.json()).toEqual({ authed: true, following: false, self: false })
  })

  it("reports following:false for an unresolvable username", async () => {
    state.user = { id: "u1" }
    state.resolveBio = { data: null }
    const res = await GET(greq("?username=ghost"))
    expect(await res.json()).toEqual({ authed: true, following: false, self: false })
  })

  it("500s (not a silent false) when the edge read errors", async () => {
    state.user = { id: "u1" }
    state.resolveBio = { data: { user_id: "u2" } }
    state.probeEdge = { data: null, error: { message: "boom" } }
    const res = await GET(greq("?username=friend"))
    expect(res.status).toBe(500)
  })

  it("resolves the username case-insensitively (lowercased before lookup)", async () => {
    state.user = { id: "u1" }
    state.resolveBio = { data: { user_id: "u2" } }
    state.probeEdge = { data: { followee_user_id: "u2" }, error: null }
    const res = await GET(greq("?username=FrIeNd"))
    expect((await res.json()).following).toBe(true)
  })
})

describe("POST /api/profile/follows", () => {
  it("401s when unauthenticated", async () => {
    expect((await POST(preq({ username: "x" }))).status).toBe(401)
  })

  it("400s when username is missing", async () => {
    state.user = { id: "u1" }
    const res = await POST(preq({}))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("username required")
  })

  it("404s when the username does not resolve", async () => {
    state.user = { id: "u1" }
    state.resolveBio = { data: null }
    const res = await POST(preq({ username: "ghost" }))
    expect(res.status).toBe(404)
    expect((await res.json()).error).toBe("User not found")
  })

  it("400s when trying to follow yourself", async () => {
    state.user = { id: "u1" }
    state.resolveBio = { data: { user_id: "u1" } }
    const res = await POST(preq({ username: "me" }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("Cannot follow yourself")
  })

  it("follows on success and returns the followee id", async () => {
    state.user = { id: "u1" }
    state.resolveBio = { data: { user_id: "u2" } }
    state.followsResult = { data: null, error: null } // upsert ok
    const res = await POST(preq({ username: "friend" }))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, followee_user_id: "u2" })
  })

  it("500s when the upsert errors", async () => {
    state.user = { id: "u1" }
    state.resolveBio = { data: { user_id: "u2" } }
    state.followsResult = { data: null, error: { message: "upsert boom" } }
    const res = await POST(preq({ username: "friend" }))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("upsert boom")
  })
})

describe("DELETE /api/profile/follows", () => {
  it("401s when unauthenticated", async () => {
    expect((await DELETE(preq({ username: "x" }))).status).toBe(401)
  })

  it("400s when username is missing", async () => {
    state.user = { id: "u1" }
    expect((await DELETE(preq({}))).status).toBe(400)
  })

  it("404s when the username does not resolve", async () => {
    state.user = { id: "u1" }
    state.resolveBio = { data: null }
    expect((await DELETE(preq({ username: "ghost" }))).status).toBe(404)
  })

  it("unfollows on success", async () => {
    state.user = { id: "u1" }
    state.resolveBio = { data: { user_id: "u2" } }
    state.followsResult = { data: null, error: null }
    const res = await DELETE(preq({ username: "friend" }))
    expect(res.status).toBe(200)
    expect((await res.json()).ok).toBe(true)
  })

  it("500s when the delete errors", async () => {
    state.user = { id: "u1" }
    state.resolveBio = { data: { user_id: "u2" } }
    state.followsResult = { data: null, error: { message: "del boom" } }
    expect((await DELETE(preq({ username: "friend" }))).status).toBe(500)
  })
})

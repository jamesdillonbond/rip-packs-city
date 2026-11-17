import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for /api/profile/first-run-tour.
// GET/POST are requireUser()-gated → 401 unauthenticated. Pin the fail-closed
// 401 on GET, the authed GET happy path (maybeSingle → completed flag), and
// the POST invalid-JSON 400 guard.

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

import { GET, POST } from "@/app/api/profile/first-run-tour/route"

const nreq = () => ({}) as any
const badJsonReq = () =>
  ({
    json: async () => {
      throw new Error("bad json")
    },
  }) as any

beforeEach(() => {
  state.user = null
  state.bio = { data: null, error: null }
})

describe("/api/profile/first-run-tour", () => {
  it("GET 401s when unauthenticated (fail-closed)", async () => {
    state.user = null
    const res = await GET(nreq())
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe("Authentication required")
  })

  it("GET reports completed=true when a stamp exists", async () => {
    state.user = { id: "u1" }
    state.bio = { data: { first_run_completed_at: "2026-07-01T00:00:00Z" }, error: null }
    const res = await GET(nreq())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.completed).toBe(true)
    expect(body.completed_at).toBe("2026-07-01T00:00:00Z")
  })

  it("GET reports completed=false when no stamp exists", async () => {
    state.user = { id: "u1" }
    state.bio = { data: null, error: null }
    const res = await GET(nreq())
    expect((await res.json()).completed).toBe(false)
  })

  it("POST 400s on invalid JSON for an authed user", async () => {
    state.user = { id: "u1" }
    const res = await POST(badJsonReq())
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("Invalid JSON body")
  })
})

// --- deeper legs: GET 500, POST auth/stamp/reset/500 ---

const jreq = (body: any) => ({ json: async () => body }) as any

describe("/api/profile/first-run-tour — deeper legs", () => {
  it("GET 500s on a profile_bio read error", async () => {
    state.user = { id: "u1" }
    state.bio = { data: null, error: { message: "bio down" } }
    const res = await GET(nreq())
    expect(res.status).toBe(500)
    expect((await res.json()).error).not.toContain("bio down")
  })

  it("POST 401s when unauthenticated (fail-closed)", async () => {
    state.user = null
    expect((await POST(jreq({ completed: true }))).status).toBe(401)
  })

  it("POST { completed: true } stamps a timestamp", async () => {
    state.user = { id: "u1" }
    state.bio = { data: null, error: null }
    const body = await (await POST(jreq({ completed: true }))).json()
    expect(body.ok).toBe(true)
    expect(typeof body.completed_at).toBe("string")
    expect(Number.isFinite(Date.parse(body.completed_at))).toBe(true)
  })

  it("POST { completed: false } resets the stamp to null (restart-tour path)", async () => {
    state.user = { id: "u1" }
    state.bio = { data: null, error: null }
    const body = await (await POST(jreq({ completed: false }))).json()
    expect(body.completed_at).toBeNull()
  })

  it("POST with no completed field stamps (defaults to done, not reset)", async () => {
    state.user = { id: "u1" }
    state.bio = { data: null, error: null }
    expect((await (await POST(jreq({}))).json()).completed_at).not.toBeNull()
  })

  it("POST 500s on an upsert error", async () => {
    state.user = { id: "u1" }
    state.bio = { data: null, error: { message: "upsert down" } }
    expect((await POST(jreq({ completed: true }))).status).toBe(500)
  })
})

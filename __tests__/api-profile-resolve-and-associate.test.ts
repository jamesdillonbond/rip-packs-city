import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for /api/profile/resolve-and-associate (POST only).
// getCurrentUser cookie-auth-gated (with a 250ms one-shot retry) → 401. Then
// JSON-body / username guards, and the resolver-driven 404 (unknown username)
// and 502 (GQL unreachable) branches — all of which return BEFORE the after()
// fire-and-forget block, so no request-scope hazard is triggered.

const state: { user: any; resolved: any; resolveThrows: boolean } = {
  user: null,
  resolved: null,
  resolveThrows: false,
}

vi.mock("@/lib/supabase", () => {
  const build = () => {
    const b: any = {
      select: () => b, upsert: () => b, eq: () => b,
      then: (resolve: any) => resolve({ data: null, error: null }),
    }
    return b
  }
  const client: any = { from: () => build(), rpc: async () => ({ data: 0, error: null }) }
  return { supabase: client, supabaseAdmin: client }
})

vi.mock("@/lib/auth/supabase-server", () => ({
  getCurrentUser: async () => state.user,
}))

vi.mock("@/lib/topshot-username-resolve", () => ({
  resolveTopShotUsername: async () => {
    if (state.resolveThrows) throw new Error("gql down")
    return state.resolved
  },
}))

import { POST } from "@/app/api/profile/resolve-and-associate/route"

const req = (body?: any, throws = false) =>
  ({
    url: "https://t/api/profile/resolve-and-associate",
    json: async () => {
      if (throws) throw new Error("bad json")
      return body
    },
  }) as any

beforeEach(() => {
  state.user = null
  state.resolved = null
  state.resolveThrows = false
})

describe("POST /api/profile/resolve-and-associate", () => {
  it("401s when unauthenticated (fail-closed)", async () => {
    const res = await POST(req({ username: "trevor" }))
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe("Authentication required")
  })

  it("400s on invalid JSON body", async () => {
    state.user = { id: "u1" }
    const res = await POST(req(undefined, true))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("Invalid JSON body")
  })

  it("400s when username is missing", async () => {
    state.user = { id: "u1" }
    const res = await POST(req({ username: "  " }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("username required")
  })

  it("404s when the username can't be resolved", async () => {
    state.user = { id: "u1" }
    state.resolved = null
    const res = await POST(req({ username: "ghost" }))
    expect(res.status).toBe(404)
  })

  it("502s when the Top Shot directory throws", async () => {
    state.user = { id: "u1" }
    state.resolveThrows = true
    const res = await POST(req({ username: "trevor" }))
    expect(res.status).toBe(502)
  })
})

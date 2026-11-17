import { describe, it, expect, beforeEach, vi } from "vitest"

// /api/market/summary — cookie-auth-gated get_market_summary wrapper. Pin the
// 401-when-unauthenticated guard, the authed happy path, and error → 500.

const rpc: { data: any; error: any } = { data: null, error: null }
const auth: { user: any } = { user: null }

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: { rpc: async () => ({ data: rpc.data, error: rpc.error }) },
}))
vi.mock("@/lib/auth/supabase-server", () => ({
  getCurrentUser: async () => auth.user,
}))

import { GET } from "@/app/api/market/summary/route"

beforeEach(() => { rpc.data = null; rpc.error = null; auth.user = null })

describe("GET /api/market/summary", () => {
  it("401s when unauthenticated", async () => {
    auth.user = null
    const res = await GET()
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe("Authentication required")
  })

  it("returns the summary for an authenticated user", async () => {
    auth.user = { id: "u1" }
    rpc.data = { volume: 123 }
    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.summary).toEqual({ volume: 123 })
  })

  it("500s on an RPC error for an authed user", async () => {
    auth.user = { id: "u1" }
    rpc.error = { message: "db" }
    expect((await GET()).status).toBe(500)
  })
})

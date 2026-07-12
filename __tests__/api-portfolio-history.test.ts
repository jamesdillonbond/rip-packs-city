import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for GET /api/portfolio/history.
// Cookie-auth gated (getCurrentUser): 401 when unauthenticated, then 400 without
// owner_key, then the get_portfolio_history RPC happy path. Mocks @/lib/supabase
// and @/lib/auth/supabase-server.

const rpc: { data: any; error: any } = { data: null, error: null }
const auth: { user: any } = { user: null }

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: { rpc: async () => ({ data: rpc.data, error: rpc.error }) },
}))
vi.mock("@/lib/auth/supabase-server", () => ({
  getCurrentUser: async () => auth.user,
}))

import { GET } from "@/app/api/portfolio/history/route"

const req = (url: string) => ({ nextUrl: new URL(url) }) as any

beforeEach(() => {
  rpc.data = null
  rpc.error = null
  auth.user = null
})

describe("GET /api/portfolio/history", () => {
  it("401s when unauthenticated", async () => {
    const res = await GET(req("https://t/api/portfolio/history?owner_key=0xabc"))
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe("Authentication required")
  })

  it("400s without an owner_key for an authed user", async () => {
    auth.user = { id: "u1" }
    const res = await GET(req("https://t/api/portfolio/history"))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("owner_key param required")
  })

  it("returns history for an authed user with an owner_key", async () => {
    auth.user = { id: "u1" }
    rpc.data = [{ day: "2026-07-01", total_fmv: 500 }]
    const res = await GET(req("https://t/api/portfolio/history?owner_key=0xabc&days=7"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.days).toBe(7)
    expect(body.history).toHaveLength(1)
  })

  it("500s on an RPC error", async () => {
    auth.user = { id: "u1" }
    rpc.error = { message: "db down" }
    const res = await GET(req("https://t/api/portfolio/history?owner_key=0xabc"))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("db down")
  })
})

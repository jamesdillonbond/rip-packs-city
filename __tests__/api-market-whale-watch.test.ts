import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for /api/market/whale-watch (GET). Cookie-auth gated
// via getCurrentUser; wraps get_whale_watch_7d. Mirrors the market-summary
// template. Pins the 401 guard, the authed happy path, and rpc error → 500.

const rpc: { data: any; error: any } = { data: null, error: null }
const auth: { user: any } = { user: null }

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: { rpc: async () => ({ data: rpc.data, error: rpc.error }) },
}))
vi.mock("@/lib/auth/supabase-server", () => ({
  getCurrentUser: async () => auth.user,
}))

import { GET } from "@/app/api/market/whale-watch/route"

const req = (url: string) => ({ nextUrl: new URL(url) }) as any

beforeEach(() => {
  rpc.data = null
  rpc.error = null
  auth.user = null
})

describe("GET /api/market/whale-watch", () => {
  it("401s when unauthenticated", async () => {
    auth.user = null
    const res = await GET(req("https://t/api/market/whale-watch"))
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe("Authentication required")
  })

  it("returns whales for an authed user", async () => {
    auth.user = { id: "u1" }
    rpc.data = [{ wallet: "0xabc" }]
    const res = await GET(req("https://t/api/market/whale-watch?slug=nfl_all_day&limit=3"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.slug).toBe("nfl_all_day")
    expect(body.limit).toBe(3)
    expect(body.whales).toEqual([{ wallet: "0xabc" }])
  })

  it("500s on an rpc error for an authed user", async () => {
    auth.user = { id: "u1" }
    rpc.error = { message: "db down" }
    const res = await GET(req("https://t/api/market/whale-watch"))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("db down")
  })
})

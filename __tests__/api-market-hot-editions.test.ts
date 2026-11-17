import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for /api/market/hot-editions (GET). Cookie-auth gated
// via getCurrentUser; wraps get_hot_editions_24h. Mirrors the market-summary
// template. Pins the 401 guard, slug normalization, the authed happy path, and
// rpc error → 500.

const rpc: { data: any; error: any } = { data: null, error: null }
const auth: { user: any } = { user: null }

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: { rpc: async () => ({ data: rpc.data, error: rpc.error }) },
}))
vi.mock("@/lib/auth/supabase-server", () => ({
  getCurrentUser: async () => auth.user,
}))

import { GET } from "@/app/api/market/hot-editions/route"

const req = (url: string) => ({ nextUrl: new URL(url) }) as any

beforeEach(() => {
  rpc.data = null
  rpc.error = null
  auth.user = null
})

describe("GET /api/market/hot-editions", () => {
  it("401s when unauthenticated", async () => {
    auth.user = null
    const res = await GET(req("https://t/api/market/hot-editions"))
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe("Authentication required")
  })

  it("returns editions for an authed user and echoes the valid slug", async () => {
    auth.user = { id: "u1" }
    rpc.data = [{ edition_id: "e1" }]
    const res = await GET(req("https://t/api/market/hot-editions?slug=nba_top_shot&limit=5"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.slug).toBe("nba_top_shot")
    expect(body.limit).toBe(5)
    expect(body.editions).toEqual([{ edition_id: "e1" }])
  })

  // INVERTED 2026-10-10 — this pinned "nulls an invalid slug rather than
  // 400ing": null is ALL collections to get_hot_editions_24h, so ?slug=bogus
  // was answered with every collection's hot editions. Refuse it.
  for (const slug of ["bogus", "constructor", "candy_mlb"]) {
    it(`refuses a present but unsupported slug (${slug}) — never widens to all`, async () => {
      auth.user = { id: "u1" }
      rpc.data = [{ edition_key: "1:1" }]
      const res = await GET(req(`https://t/api/market/hot-editions?slug=${slug}`))
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.editions ?? body.rows ?? body.data).toBeUndefined()
    })
  }

  it("reads the registry's hyphen slug as its DB slug", async () => {
    auth.user = { id: "u1" }
    rpc.data = []
    const body = await (await GET(req("https://t/api/market/hot-editions?slug=nba-top-shot"))).json()
    expect(body.slug).toBe("nba_top_shot")
  })

  it("an absent slug still means all collections", async () => {
    auth.user = { id: "u1" }
    rpc.data = []
    const body = await (await GET(req("https://t/api/market/hot-editions"))).json()
    expect(body.slug).toBeNull()
  })

  it("500s on an rpc error for an authed user", async () => {
    auth.user = { id: "u1" }
    rpc.error = { message: "db down" }
    const res = await GET(req("https://t/api/market/hot-editions"))
    expect(res.status).toBe(500)
    expect((await res.json()).error).not.toContain("db down")
  })
})

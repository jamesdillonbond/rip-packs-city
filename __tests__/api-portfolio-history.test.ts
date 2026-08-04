import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for GET /api/portfolio/history.
// Ownership-gated (requireOwnedKey): 400 without owner_key, then the guard
// (401 unauthenticated / 403 when owner_key is not the caller's), then the
// get_portfolio_history RPC happy path. Mocks @/lib/supabase and the
// @/lib/auth/owner-key-guard IDOR guard.

const rpc: { data: any; error: any } = { data: null, error: null }
// requireOwnedKey result: { user } lets the read proceed; a Response short-
// circuits (401 unauthenticated / 403 not-the-caller's-key).
const guard: { result: any } = { result: { user: { id: "u1" } } }

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: { rpc: async () => ({ data: rpc.data, error: rpc.error }) },
}))
vi.mock("@/lib/auth/owner-key-guard", () => ({
  requireOwnedKey: async () => guard.result,
}))

import { GET } from "@/app/api/portfolio/history/route"

const req = (url: string) => ({ nextUrl: new URL(url) }) as any

beforeEach(() => {
  rpc.data = null
  rpc.error = null
  guard.result = { user: { id: "u1" } }
})

describe("GET /api/portfolio/history", () => {
  it("400s without an owner_key", async () => {
    const res = await GET(req("https://t/api/portfolio/history"))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("owner_key param required")
  })

  it("401s when unauthenticated (guard denies)", async () => {
    guard.result = new Response(JSON.stringify({ error: "Authentication required" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    })
    const res = await GET(req("https://t/api/portfolio/history?owner_key=0xabc"))
    expect(res.status).toBe(401)
  })

  it("403s when owner_key is not the caller's (IDOR guard)", async () => {
    guard.result = new Response(JSON.stringify({ error: "Forbidden" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    })
    const res = await GET(req("https://t/api/portfolio/history?owner_key=0xsomeone-else"))
    expect(res.status).toBe(403)
  })

  it("returns history for an authed user with an owner_key", async () => {
    rpc.data = [{ day: "2026-07-01", total_fmv: 500 }]
    const res = await GET(req("https://t/api/portfolio/history?owner_key=0xabc&days=7"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.days).toBe(7)
    expect(body.history).toHaveLength(1)
  })

  it("500s on an RPC error", async () => {
    rpc.error = { message: "db down" }
    const res = await GET(req("https://t/api/portfolio/history?owner_key=0xabc"))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("db down")
  })
})

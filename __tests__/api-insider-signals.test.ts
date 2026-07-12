import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for /api/insider-signals (GET).
// Two modes: ?collection=<kebab> is PUBLIC (SECDEF get_insider_signals_top_n
// RPC); the no-param legacy pool read is session-gated (getCurrentUser → 401).
// Pins the auth split, the collection happy path, and the RPC-error 500.

const state: { rpc: any; user: any } = { rpc: { data: [], error: null }, user: null }

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: { rpc: async () => state.rpc },
}))
vi.mock("@/lib/auth/supabase-server", () => ({
  getCurrentUser: async () => state.user,
}))

import { GET } from "@/app/api/insider-signals/route"

const req = (u: string) => ({ url: u, nextUrl: new URL(u) }) as any

beforeEach(() => {
  state.rpc = { data: [], error: null }
  state.user = null
})

describe("GET /api/insider-signals", () => {
  it("401s the legacy no-param pool read when unauthenticated", async () => {
    state.user = null
    const res = await GET(req("https://t/api/insider-signals"))
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe("Authentication required")
  })

  it("serves the collection-scoped mode publicly (no session)", async () => {
    state.user = null
    state.rpc = { data: [{ id: 1, title: "signal" }], error: null }
    const res = await GET(req("https://t/api/insider-signals?collection=nba-top-shot&limit=5"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.collection).toBe("nba_top_shot") // kebab → DB slug
    expect(body.alerts).toHaveLength(1)
  })

  it("500s when the collection RPC errors", async () => {
    state.rpc = { data: null, error: { message: "rpc down" } }
    const res = await GET(req("https://t/api/insider-signals?collection=ufc"))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("rpc down")
  })
})

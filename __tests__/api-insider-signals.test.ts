import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for /api/insider-signals (GET).
// Two modes: ?collection=<kebab> is PUBLIC (SECDEF get_insider_signals_top_n
// RPC); the no-param legacy pool read is session-gated (getCurrentUser → 401).
// Pins the auth split, the collection happy path, and the RPC-error 500.

const state: { rpc: any; user: any; pool: any; rpcArgs: any } = {
  rpc: { data: [], error: null },
  user: null,
  pool: { data: [], error: null },
  rpcArgs: null,
}

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    rpc: async (_name: string, args: any) => { state.rpcArgs = args; return state.rpc },
    from() {
      const b: any = {
        select: () => b, or: () => b, order: () => b, limit: () => b,
        then: (resolve: any) => resolve(state.pool),
      }
      return b
    },
  },
}))
vi.mock("@/lib/auth/supabase-server", () => ({
  getCurrentUser: async () => state.user,
}))

import { GET } from "@/app/api/insider-signals/route"

const req = (u: string) => ({ url: u, nextUrl: new URL(u) }) as any

beforeEach(() => {
  state.rpc = { data: [], error: null }
  state.user = null
  state.pool = { data: [], error: null }
  state.rpcArgs = null
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
    // The driver message must NOT be published — lib/api-error.ts classifies it.
    expect((await res.json()).error).not.toContain("rpc down")
  })
})

// --- deeper legs: the authed legacy pool read, limit clamping, slug passthrough ---

describe("GET /api/insider-signals — legacy pool read (authed)", () => {
  it("returns the non-expired alert pool for a signed-in user", async () => {
    state.user = { id: "u1" }
    state.pool = { data: [{ id: "a1", severity: "high" }, { id: "a2", severity: "low" }], error: null }
    const res = await GET(req("https://t/api/insider-signals"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.alerts).toHaveLength(2)
  })

  it("defaults to an empty list when the pool read returns null data", async () => {
    state.user = { id: "u1" }
    state.pool = { data: null, error: null }
    expect((await (await GET(req("https://t/api/insider-signals"))).json()).alerts).toEqual([])
  })

  it("500s when the pool read errors", async () => {
    state.user = { id: "u1" }
    state.pool = { data: null, error: { message: "pool down" } }
    const res = await GET(req("https://t/api/insider-signals"))
    expect(res.status).toBe(500)
    // The driver message must NOT be published — lib/api-error.ts classifies it.
    expect((await res.json()).error).not.toContain("pool down")
  })
})

describe("GET /api/insider-signals — limit + slug handling", () => {
  it("defaults the limit to 8 when absent or unparseable", async () => {
    await GET(req("https://t/api/insider-signals?collection=nba-top-shot"))
    expect(state.rpcArgs.p_limit).toBe(8)
    await GET(req("https://t/api/insider-signals?collection=nba-top-shot&limit=abc"))
    expect(state.rpcArgs.p_limit).toBe(8)
  })

  it("clamps the limit to [1, 50]", async () => {
    await GET(req("https://t/api/insider-signals?collection=nba-top-shot&limit=999"))
    expect(state.rpcArgs.p_limit).toBe(50)
    await GET(req("https://t/api/insider-signals?collection=nba-top-shot&limit=0"))
    expect(state.rpcArgs.p_limit).toBe(1)
    await GET(req("https://t/api/insider-signals?collection=nba-top-shot&limit=-5"))
    expect(state.rpcArgs.p_limit).toBe(1)
  })

  it("maps ufc -> ufc_strike (the DB slug the detectors run against)", async () => {
    const body = await (await GET(req("https://t/api/insider-signals?collection=ufc"))).json()
    expect(state.rpcArgs.p_collection_slug).toBe("ufc_strike")
    expect(body.collection).toBe("ufc_strike")
  })

  it("passes an unmapped collection through unchanged", async () => {
    const body = await (await GET(req("https://t/api/insider-signals?collection=candy_mlb"))).json()
    expect(state.rpcArgs.p_collection_slug).toBe("candy_mlb")
    expect(body.collection).toBe("candy_mlb")
  })

  it("defaults alerts to [] when the RPC returns null data", async () => {
    state.rpc = { data: null, error: null }
    expect((await (await GET(req("https://t/api/insider-signals?collection=nba-top-shot"))).json()).alerts).toEqual([])
  })
})

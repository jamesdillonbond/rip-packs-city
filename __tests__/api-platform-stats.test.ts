import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for GET /api/platform-stats (public, no auth).
// Thin wrapper around the get_platform_stats RPC. NOTE: it never 500s — an RPC
// error (or thrown) degrades to a 200 { error: "stats_unavailable" } with
// no-store caching. Mocks @/lib/supabase's supabaseAdmin.rpc.

const rpc: { data: any; error: any } = { data: null, error: null }

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: { rpc: async () => ({ data: rpc.data, error: rpc.error }) },
}))

import { GET } from "@/app/api/platform-stats/route"

beforeEach(() => {
  rpc.data = null
  rpc.error = null
})

describe("GET /api/platform-stats", () => {
  it("returns the stats payload on success", async () => {
    rpc.data = { wallets: 42, moments: 1000 }
    const res = await GET()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ wallets: 42, moments: 1000 })
  })

  it("degrades to 200 stats_unavailable on an RPC error", async () => {
    rpc.error = { message: "db down" }
    const res = await GET()
    expect(res.status).toBe(200)
    expect((await res.json()).error).toBe("stats_unavailable")
    expect(res.headers.get("Cache-Control")).toBe("no-store")
  })
})

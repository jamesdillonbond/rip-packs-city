import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for /api/analytics (the bare analytics root).
// Pins the two param-validation 400s that return before any DB work, plus a
// mocked empty happy path. Mocks @/lib/supabase (supabaseAdmin.rpc, called
// directly here — not via rpcWithRetry) and @/lib/topshot (username→wallet
// resolver, never hit when a raw 0x address is passed). COLLECTION_UUID_BY_SLUG
// is real.

const rpcByFn: Record<string, any> = {}

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    rpc: async (fn: string) => rpcByFn[fn] ?? { data: null },
  },
}))
vi.mock("@/lib/topshot", () => ({
  topshotGraphql: async () => {
    throw new Error("should not resolve username in these tests")
  },
}))

import { GET } from "@/app/api/analytics/route"

const req = (u: string) => ({ nextUrl: new URL(u), url: u }) as any

beforeEach(() => {
  for (const k of Object.keys(rpcByFn)) delete rpcByFn[k]
})

describe("GET /api/analytics", () => {
  it("400s without a wallet", async () => {
    const res = await GET(req("https://t/api/analytics"))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("wallet required")
  })

  it("400s when collection_id is missing/unresolvable", async () => {
    const res = await GET(req("https://t/api/analytics?wallet=0x0000000000000000"))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain("collection_id required")
  })

  it("returns an empty roll-up for a raw 0x wallet with an empty portfolio", async () => {
    rpcByFn["get_acquisition_stats"] = { data: {} }
    rpcByFn["get_wallet_moments_with_fmv"] = { data: null }
    const res = await GET(
      req("https://t/api/analytics?wallet=0x0000000000000000&collection_id=nba-top-shot")
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.wallet).toBe("0x0000000000000000")
    expect(body.collection_id).toBe("95f28a17-224a-4025-96ad-adf8a4c63bfd")
    expect(body.total_moments).toBe(0)
    expect(body.total_fmv).toBe(0)
    expect(Array.isArray(body.tiers)).toBe(true)
  })
})

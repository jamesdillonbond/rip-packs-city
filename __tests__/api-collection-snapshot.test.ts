import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for /api/collection-snapshot (backs the public /share
// card). Mocks @supabase/supabase-js so the module-level client's .rpc is
// controllable. Pins the required-param guard, the RPC field mapping, and the
// error fallback shape.

const rpcState: { data: any; error: any } = { data: null, error: null }

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    rpc: async () => ({ data: rpcState.data, error: rpcState.error }),
  }),
}))

import { GET } from "@/app/api/collection-snapshot/route"

function req(url: string) {
  return { nextUrl: new URL(url) } as any
}

beforeEach(() => {
  rpcState.data = null
  rpcState.error = null
})

describe("GET /api/collection-snapshot", () => {
  it("400s when wallet is missing/blank", async () => {
    expect((await GET(req("https://t/api/collection-snapshot"))).status).toBe(400)
    expect((await GET(req("https://t/api/collection-snapshot?wallet=%20%20"))).status).toBe(400)
  })

  it("maps the RPC snapshot into the card payload", async () => {
    rpcState.data = {
      totalMoments: 1200,
      totalFmv: 34567.89,
      topMoments: [{ id: "m1" }],
      badgeCount: 7,
      seriesBreakdown: { "4": 10 },
      perCollection: [{ slug: "nba-top-shot" }],
      rarest: { id: "r1" },
    }
    const res = await GET(req("https://t/api/collection-snapshot?wallet=0xABC"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.wallet).toBe("0xABC")
    expect(body.totalMoments).toBe(1200)
    expect(body.totalFmv).toBe(34567.89)
    expect(body.badgeCount).toBe(7)
    expect(body.topMoments).toHaveLength(1)
  })

  it("defaults missing snapshot fields to safe zeros/empties", async () => {
    rpcState.data = {}
    const body = await (await GET(req("https://t/api/collection-snapshot?wallet=0xABC"))).json()
    expect(body.totalMoments).toBe(0)
    expect(body.totalFmv).toBe(0)
    expect(body.topMoments).toEqual([])
    expect(body.seriesBreakdown).toEqual({})
  })

  it("500s when the RPC returns an error", async () => {
    rpcState.error = { message: "boom" }
    const res = await GET(req("https://t/api/collection-snapshot?wallet=0xABC"))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("Failed to fetch wallet data")
  })
})

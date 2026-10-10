import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for GET /api/analytics/wallets/net-marketplace. No
// guards (unknown collection → "all"). Wraps flowty_top_net_marketplace and
// coerces the numeric columns. Pins the happy path (collection/days echoed,
// numeric coercion) and the rpc-error 500.

const rpc: { data: any; error: any; throws?: boolean } = { data: null, error: null }

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    rpc: async () => {
      if (rpc.throws) throw new Error("connection reset")
      return { data: rpc.data, error: rpc.error }
    },
  },
}))

import { GET } from "@/app/api/analytics/wallets/net-marketplace/route"

const req = (url = "https://t/api/analytics/wallets/net-marketplace") => ({ url }) as any

beforeEach(() => { rpc.data = null; rpc.error = null; rpc.throws = false })

describe("GET /api/analytics/wallets/net-marketplace", () => {
  it("coerces numeric fields and echoes normalized params", async () => {
    rpc.data = [{ addr: "0xabc", buy_volume_usd: "100.5", sell_volume_usd: null, net_position_usd: "50" }]
    const res = await GET(req("https://t/api/analytics/wallets/net-marketplace?collection=TopShot&days=7&limit=5"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.collection).toBe("topshot")
    expect(body.days).toBe(7)
    expect(body.rows[0].buy_volume_usd).toBe(100.5)
    expect(body.rows[0].sell_volume_usd).toBe(0) // null → 0
    expect(body.rows[0].net_position_usd).toBe(50)
  })

  // INVERTED 2026-10-09 — this case asserted an unknown collection fell back to
  // "all": every collection's wallets answered a question about one. Refuse it.
  it("refuses a present but unknown collection — never widens to all", async () => {
    rpc.data = [{ addr: "0xabc", buy_volume_usd: "100.5" }]
    const res = await GET(req("https://t/api/analytics/wallets/net-marketplace?collection=nope"))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe("unsupported_collection")
    expect(body.rows).toBeUndefined()
  })

  it("an absent collection still means all", async () => {
    rpc.data = []
    const res = await GET(req("https://t/api/analytics/wallets/net-marketplace"))
    expect((await res.json()).collection).toBe("all")
  })

  it("500s on an rpc error", async () => {
    rpc.error = { message: "db" }
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("net_marketplace_failed")
  })

  it("500s when the rpc throws (outer catch path)", async () => {
    rpc.throws = true
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("net_marketplace_failed")
  })
})

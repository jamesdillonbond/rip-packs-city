import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for GET /api/analytics/wallets/net-marketplace. No
// guards (unknown collection → "all"). Wraps flowty_top_net_marketplace and
// coerces the numeric columns. Pins the happy path (collection/days echoed,
// numeric coercion) and the rpc-error 500.

const rpc: { data: any; error: any } = { data: null, error: null }

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: { rpc: async () => ({ data: rpc.data, error: rpc.error }) },
}))

import { GET } from "@/app/api/analytics/wallets/net-marketplace/route"

const req = (url = "https://t/api/analytics/wallets/net-marketplace") => ({ url }) as any

beforeEach(() => { rpc.data = null; rpc.error = null })

describe("GET /api/analytics/wallets/net-marketplace", () => {
  it("coerces numeric fields and echoes normalized params", async () => {
    rpc.data = [{ addr: "0xabc", buy_volume_usd: "100.5", sell_volume_usd: null, net_position_usd: "50" }]
    const res = await GET(req("https://t/api/analytics/wallets/net-marketplace?collection=nope&days=7&limit=5"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.collection).toBe("all") // unknown → fallback
    expect(body.days).toBe(7)
    expect(body.rows[0].buy_volume_usd).toBe(100.5)
    expect(body.rows[0].sell_volume_usd).toBe(0) // null → 0
    expect(body.rows[0].net_position_usd).toBe(50)
  })

  it("500s on an rpc error", async () => {
    rpc.error = { message: "db" }
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("net_marketplace_failed")
  })
})

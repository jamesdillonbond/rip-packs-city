import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for GET /api/analytics/wallets/[address]/position-transfers.
// Dynamic route: 2nd handler arg is { params: Promise<{ address }> }. Guards a
// non-Flow-address (400 before the RPC), otherwise wraps
// analytics_wallet_position_transfers and returns the payload verbatim. Pins
// the address guard, the happy path, and the rpc-error 500.

const rpc: { data: any; error: any } = { data: null, error: null }

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: { rpc: async () => ({ data: rpc.data, error: rpc.error }) },
}))

import { GET } from "@/app/api/analytics/wallets/[address]/position-transfers/route"

const req = () => ({ url: "https://t/api/analytics/wallets/x/position-transfers" }) as any
const ctx = (address: string) => ({ params: Promise.resolve({ address }) }) as any
const ADDR = "0xbd94cade097e50ac"

beforeEach(() => { rpc.data = null; rpc.error = null })

describe("GET /api/analytics/wallets/[address]/position-transfers", () => {
  it("400s on a malformed Flow address", async () => {
    const res = await GET(req(), ctx("0xnothex"))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("invalid_address")
  })

  it("returns the rpc payload verbatim on the happy path", async () => {
    rpc.data = { has_activity: false, transfers: [] }
    const res = await GET(req(), ctx(ADDR))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ has_activity: false, transfers: [] })
  })

  it("500s on an rpc error", async () => {
    rpc.error = { message: "db" }
    const res = await GET(req(), ctx(ADDR))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("position_transfers_failed")
  })
})

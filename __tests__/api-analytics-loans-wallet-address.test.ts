import { describe, it, expect, beforeEach, vi } from "vitest"

// /api/analytics/loans/wallet/[address] — wrapper over
// flowty_analytics_wallet_detail(p_addr) via rpcWithRetry. The [address] param
// arrives as a Promise (Next 16). Pins the address-format 400 (before DB), the
// 404 when the RPC returns null, and the happy 200.

const state: { data: any; error: any } = { data: null, error: null }

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: { rpc: async () => ({ data: state.data, error: state.error }) },
}))

import { GET } from "@/app/api/analytics/loans/wallet/[address]/route"

const req = { url: "https://t/api/analytics/loans/wallet/x" } as any
const ctx = (address: string) => ({ params: Promise.resolve({ address }) })

beforeEach(() => { state.data = null; state.error = null })

describe("GET /api/analytics/loans/wallet/[address]", () => {
  it("400s on a malformed address before hitting the DB", async () => {
    const res = await GET(req, ctx("not-a-wallet"))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("invalid_address")
  })

  it("404s when the RPC returns null for a well-formed address", async () => {
    state.data = null
    const res = await GET(req, ctx("0x0000000000000000"))
    expect(res.status).toBe(404)
    expect((await res.json()).error).toBe("not_found")
  })

  it("returns the wallet detail payload on the happy path", async () => {
    state.data = { addr: "0x0000000000000000", loans: 3 }
    const res = await GET(req, ctx("0x0000000000000000"))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(state.data)
  })

  it("500s with wallet_failed on an rpc error", async () => {
    state.error = { message: "boom" }
    const res = await GET(req, ctx("0x0000000000000000"))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("wallet_failed")
  })
})

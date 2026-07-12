import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for GET /api/pro-status (public, no auth).
// NOTE: it never errors out — a missing wallet, an RPC error, or a throw all
// return a 200 default { is_pro: false, plan: null, expires_at: null,
// days_remaining: 0 }. Only the wallet-present success path yields real data.
// Mocks @/lib/supabase's supabaseAdmin.rpc.

const rpc: { data: any; error: any } = { data: null, error: null }

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: { rpc: async () => ({ data: rpc.data, error: rpc.error }) },
}))

import { GET } from "@/app/api/pro-status/route"

const req = (url: string) => ({ nextUrl: new URL(url) }) as any

beforeEach(() => {
  rpc.data = null
  rpc.error = null
})

describe("GET /api/pro-status", () => {
  it("returns the default (not pro) when no wallet is provided", async () => {
    const res = await GET(req("https://t/api/pro-status"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.is_pro).toBe(false)
    expect(body.days_remaining).toBe(0)
  })

  it("returns pro status from the RPC for a wallet", async () => {
    rpc.data = { is_pro: true, plan: "annual", expires_at: "2027-01-01", days_remaining: 200 }
    const res = await GET(req("https://t/api/pro-status?wallet=0xABC"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.is_pro).toBe(true)
    expect(body.plan).toBe("annual")
    expect(body.days_remaining).toBe(200)
  })

  it("returns the default on an RPC error", async () => {
    rpc.error = { message: "db down" }
    const res = await GET(req("https://t/api/pro-status?wallet=0xABC"))
    expect(res.status).toBe(200)
    expect((await res.json()).is_pro).toBe(false)
  })
})

import { describe, it, expect, vi } from "vitest"

// Route integration test for POST /api/trade-chain/cancel-callback. Trade Hub is
// SHELVED: the handler returns 503 "Trade Hub is not available yet." before any
// auth/DB work whenever RPC_TRADE_ESCROW_ADDRESS is unset (the production state).
// Mocks supabaseAdmin + the auth helper so the module constructs.

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: { from: () => ({}) } }))
vi.mock("@/lib/auth/supabase-server", () => ({ getCurrentUser: async () => null }))

import { POST } from "@/app/api/trade-chain/cancel-callback/route"

const req = (body: any) => ({ json: async () => body }) as any

describe("POST /api/trade-chain/cancel-callback", () => {
  it("503s while Trade Hub is shelved (RPC_TRADE_ESCROW_ADDRESS unset)", async () => {
    const res = await POST(req({ trade_match_id: "m1" }))
    expect(res.status).toBe(503)
    expect((await res.json()).error).toContain("not available")
  })
})

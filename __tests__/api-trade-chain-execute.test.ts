import { describe, it, expect, vi } from "vitest"

// Route integration test for POST /api/trade-chain/execute. Trade Hub is SHELVED:
// returns 503 before auth/DB when RPC_TRADE_ESCROW_ADDRESS is unset. Mocks
// supabaseAdmin, the auth helper, and the stubbed FCL submitter.

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: { from: () => ({}) } }))
vi.mock("@/lib/auth/supabase-server", () => ({ getCurrentUser: async () => null }))
vi.mock("@/lib/trade-escrow/fcl-submit", () => ({ submitExecuteSwap: async () => ({ tx_id: "0xstub" }) }))

import { POST } from "@/app/api/trade-chain/execute/route"

const req = (body: any) => ({ json: async () => body }) as any

describe("POST /api/trade-chain/execute", () => {
  it("503s while Trade Hub is shelved", async () => {
    const res = await POST(req({ trade_match_id: "m1" }))
    expect(res.status).toBe(503)
    expect((await res.json()).error).toContain("not available")
  })
})

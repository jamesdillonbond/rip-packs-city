import { describe, it, expect, vi } from "vitest"

// Route integration test for /api/trade-chain/propose. POST is SHELVED: returns
// 503 before auth/DB when RPC_TRADE_ESCROW_ADDRESS is unset. GET (a status poll)
// has no env gate and fail-closes to 401 when unauthenticated (getCurrentUser →
// null). Mocks supabaseAdmin, the auth helper, and the stubbed FCL submitter.

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: { from: () => ({}) } }))
vi.mock("@/lib/auth/supabase-server", () => ({ getCurrentUser: async () => null }))
vi.mock("@/lib/trade-escrow/fcl-submit", () => ({ submitProposeTrade: async () => ({ tx_id: "0xstub" }) }))

import { GET, POST } from "@/app/api/trade-chain/propose/route"

const postReq = (body: any) => ({ json: async () => body }) as any
const getReq = (u: string) => ({ nextUrl: new URL(u) }) as any

describe("/api/trade-chain/propose", () => {
  it("POST 503s while Trade Hub is shelved", async () => {
    const res = await POST(postReq({ trade_match_id: "m1" }))
    expect(res.status).toBe(503)
  })
  it("GET 401s when unauthenticated", async () => {
    const res = await GET(getReq("https://t/api/trade-chain/propose?trade_match_id=m1"))
    expect(res.status).toBe(401)
  })
})

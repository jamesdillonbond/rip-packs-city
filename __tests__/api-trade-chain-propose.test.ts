import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for /api/trade-chain/propose. POST is SHELVED: returns
// 503 before auth/DB when RPC_TRADE_ESCROW_ADDRESS is unset (the honest gated
// behavior). GET (a status poll) has no env gate: fail-closes to 401 when
// unauthenticated, and 200s { ok, state } for a party to the match. supabaseAdmin
// is a table-keyed chainable resolving per-table maybeSingle fixtures.

const state: { user: any; single: Record<string, any> } = { user: null, single: {} }

vi.mock("@/lib/supabase", () => {
  const makeBuilder = (t: string) => {
    const b: any = {
      select: () => b, eq: () => b,
      maybeSingle: async () => state.single[t] ?? { data: null, error: null },
    }
    return b
  }
  return { supabaseAdmin: { from: (t: string) => makeBuilder(t) } }
})
vi.mock("@/lib/auth/supabase-server", () => ({ getCurrentUser: async () => state.user }))
vi.mock("@/lib/trade-escrow/fcl-submit", () => ({ submitProposeTrade: async () => ({ tx_id: "0xstub" }) }))

import { GET, POST } from "@/app/api/trade-chain/propose/route"

const postReq = (body: any) => ({ json: async () => body }) as any
const getReq = (u: string) => ({ nextUrl: new URL(u) }) as any

beforeEach(() => {
  state.user = null
  state.single = {}
})

describe("/api/trade-chain/propose", () => {
  it("POST 503s while Trade Hub is shelved", async () => {
    const res = await POST(postReq({ trade_match_id: "m1" }))
    expect(res.status).toBe(503)
  })
  it("GET 401s when unauthenticated", async () => {
    const res = await GET(getReq("https://t/api/trade-chain/propose?trade_match_id=m1"))
    expect(res.status).toBe(401)
  })

  it("GET 400s without trade_match_id", async () => {
    state.user = { id: "u1" }
    const res = await GET(getReq("https://t/api/trade-chain/propose"))
    expect(res.status).toBe(400)
  })

  it("GET 404s when the trade_match doesn't exist", async () => {
    state.user = { id: "u1" }
    state.single.trade_matches = { data: null, error: null }
    const res = await GET(getReq("https://t/api/trade-chain/propose?trade_match_id=m1"))
    expect(res.status).toBe(404)
  })

  it("GET 200s { ok, state:null } for a party to the match with no chain state yet", async () => {
    state.user = { id: "u1" }
    state.single.trade_matches = { data: { id: "m1", buyer_user_id: "u1", seller_user_id: null }, error: null }
    state.single.trade_chain_state = { data: null, error: null }
    const res = await GET(getReq("https://t/api/trade-chain/propose?trade_match_id=m1"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.state).toBeNull()
  })
})

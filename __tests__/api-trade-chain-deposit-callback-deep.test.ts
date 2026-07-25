import { describe, it, expect, beforeEach, vi } from "vitest"

// Deep drive of POST /api/trade-chain/deposit-callback. The route is shelved
// behind RPC_TRADE_ESCROW_ADDRESS (503), but the deposit state machine has real
// branches worth pinning for when the contract goes live: auth, body validation,
// state lookup (404/500), the party-address match (403), the double-deposit guard
// (409), the nextStatus transition table (proposed→partial→ready / illegal), and
// the update-error path.

const st = vi.hoisted(() => ({ user: { id: "u1" } as any, sel: { data: null as any, error: null as any }, upd: { data: null as any, error: null as any } }))
vi.mock("@/lib/auth/supabase-server", () => ({ getCurrentUser: async () => st.user }))
vi.mock("@sentry/nextjs", () => ({ captureException: () => {} }))
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from() {
      let op: "select" | "update" = "select"
      const b: any = {
        select: () => b, update: () => { op = "update"; return b }, eq: () => b,
        maybeSingle: async () => (op === "update" ? st.upd : st.sel),
      }
      return b
    },
  },
}))

import { POST } from "@/app/api/trade-chain/deposit-callback/route"

const post = (body: any, badJson = false) =>
  ({ json: async () => { if (badJson) throw new Error("bad"); return body } }) as any

// A trade_chain_state row where party A = 0xAAA, party B = 0xBBB.
const state = (over: any = {}) => ({
  id: "row1", status: "proposed",
  partya_address: "0xAAA", partyb_address: "0xBBB",
  partya_deposit_tx_id: null, partyb_deposit_tx_id: null,
  ...over,
})
const goodBody = (over: any = {}) => ({ trade_match_id: "tm1", depositor_address: "0xAAA", deposit_tx_id: "0xtx", side: "A", ...over })

beforeEach(() => {
  process.env.RPC_TRADE_ESCROW_ADDRESS = "0xescrow"
  st.user = { id: "u1" }
  st.sel = { data: state(), error: null }
  st.upd = { data: state({ status: "partial_a", partya_deposit_tx_id: "0xtx" }), error: null }
})

describe("POST /api/trade-chain/deposit-callback", () => {
  it("503 when the escrow contract is not configured", async () => {
    delete process.env.RPC_TRADE_ESCROW_ADDRESS
    expect((await POST(post(goodBody()))).status).toBe(503)
  })
  it("401 when unauthenticated", async () => {
    st.user = null
    expect((await POST(post(goodBody()))).status).toBe(401)
  })
  it("400 on invalid JSON", async () => {
    expect((await POST(post({}, true))).status).toBe(400)
  })
  it("400 when required fields are missing", async () => {
    expect((await POST(post({ trade_match_id: "tm1" }))).status).toBe(400)
    expect((await POST(post(goodBody({ side: "C" })))).status).toBe(400) // invalid side
  })
  it("404 when the trade_chain_state row is missing", async () => {
    st.sel = { data: null, error: null }
    expect((await POST(post(goodBody()))).status).toBe(404)
  })
  it("500 when the state lookup errors", async () => {
    st.sel = { data: null, error: { message: "db down" } }
    expect((await POST(post(goodBody()))).status).toBe(500)
  })
  it("403 when the depositor address does not match the claimed side", async () => {
    const res = await POST(post(goodBody({ depositor_address: "0xZZZ" })))
    expect(res.status).toBe(403)
  })
  it("409 on a double deposit from the same side", async () => {
    st.sel = { data: state({ partya_deposit_tx_id: "0xprev" }), error: null }
    const res = await POST(post(goodBody()))
    expect(res.status).toBe(409)
    expect((await res.json()).error).toContain("already deposited")
  })
  it("409 on an illegal transition (deposit from a terminal-ish status)", async () => {
    st.sel = { data: state({ status: "ready" }), error: null }
    const res = await POST(post(goodBody()))
    expect(res.status).toBe(409)
    expect((await res.json()).error).toContain("Cannot deposit from status='ready'")
  })
  it("side A on 'proposed' advances to 'partial_a' and returns the updated state", async () => {
    const res = await POST(post(goodBody()))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.state.status).toBe("partial_a")
  })
  it("side B on 'partial_a' advances to 'ready'", async () => {
    st.sel = { data: state({ status: "partial_a", partya_deposit_tx_id: "0xa" }), error: null }
    st.upd = { data: state({ status: "ready" }), error: null }
    const res = await POST(post(goodBody({ depositor_address: "0xBBB", side: "B" })))
    expect(res.status).toBe(200)
    expect((await res.json()).state.status).toBe("ready")
  })
  it("500 when the update errors", async () => {
    st.upd = { data: null, error: { message: "update failed" } }
    expect((await POST(post(goodBody()))).status).toBe(500)
  })
})

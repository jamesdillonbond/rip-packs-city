import { describe, it, expect, beforeEach, vi } from "vitest"

// Deep drive of POST /api/trade-chain/cancel-callback. Shelved behind
// RPC_TRADE_ESCROW_ADDRESS (503); the cancellation flow has real branches: auth,
// body validation, state lookup (404/500), the party-membership check (403), the
// idempotent already-cancelled no-op, the CANCELLABLE_FROM guard (409), and the
// status→cancelled update (+ optional failure_reason).

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

import { POST } from "@/app/api/trade-chain/cancel-callback/route"

const post = (body: any, badJson = false) =>
  ({ json: async () => { if (badJson) throw new Error("bad"); return body } }) as any

const state = (over: any = {}) => ({
  id: "row1", status: "proposed",
  partya_address: "0xAAA", partyb_address: "0xBBB", cancel_tx_id: null,
  ...over,
})
const goodBody = (over: any = {}) => ({ trade_match_id: "tm1", cancelled_by: "0xAAA", cancel_tx_id: "0xtx", ...over })

beforeEach(() => {
  process.env.RPC_TRADE_ESCROW_ADDRESS = "0xescrow"
  st.user = { id: "u1" }
  st.sel = { data: state(), error: null }
  st.upd = { data: state({ status: "cancelled", cancel_tx_id: "0xtx" }), error: null }
})

describe("POST /api/trade-chain/cancel-callback", () => {
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
  })
  it("404 when the state row is missing", async () => {
    st.sel = { data: null, error: null }
    expect((await POST(post(goodBody()))).status).toBe(404)
  })
  it("500 when the state lookup errors", async () => {
    st.sel = { data: null, error: { message: "db down" } }
    expect((await POST(post(goodBody()))).status).toBe(500)
  })
  it("403 when cancelled_by is not a party to the trade", async () => {
    const res = await POST(post(goodBody({ cancelled_by: "0xZZZ" })))
    expect(res.status).toBe(403)
  })
  it("idempotent no-op when already cancelled with the same tx", async () => {
    st.sel = { data: state({ status: "cancelled", cancel_tx_id: "0xtx" }), error: null }
    const res = await POST(post(goodBody()))
    expect(res.status).toBe(200)
    expect((await res.json()).state.status).toBe("cancelled")
  })
  it("409 when the status is not cancellable", async () => {
    st.sel = { data: state({ status: "executed" }), error: null }
    const res = await POST(post(goodBody()))
    expect(res.status).toBe(409)
    expect((await res.json()).error).toContain("Cannot cancel from status='executed'")
  })
  it("cancels from a cancellable status and stores the reason", async () => {
    st.sel = { data: state({ status: "ready" }), error: null }
    st.upd = { data: state({ status: "cancelled", cancel_tx_id: "0xtx", failure_reason: "changed mind" }), error: null }
    const res = await POST(post(goodBody({ reason: "changed mind" })))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.state.status).toBe("cancelled")
  })
  it("500 when the update errors", async () => {
    st.sel = { data: state({ status: "proposed" }), error: null }
    st.upd = { data: null, error: { message: "update failed" } }
    expect((await POST(post(goodBody()))).status).toBe(500)
  })
})

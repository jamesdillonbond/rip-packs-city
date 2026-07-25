import { describe, it, expect, beforeEach, vi } from "vitest"

// Deep drive of POST /api/trade-chain/execute. Shelved behind
// RPC_TRADE_ESCROW_ADDRESS (503). Fires the swap once both sides deposited
// (status='ready'). Legs pinned: auth, body validation, state lookup (404/500),
// the ready-only guard (409), the chain_trade_id-null stub passthrough, the
// status→executed update, and the update-error path.

const st = vi.hoisted(() => ({ user: { id: "u1" } as any, sel: { data: null as any, error: null as any }, upd: { data: null as any, error: null as any } }))
vi.mock("@/lib/auth/supabase-server", () => ({ getCurrentUser: async () => st.user }))
vi.mock("@sentry/nextjs", () => ({ captureException: () => {} }))
vi.mock("@/lib/trade-escrow/fcl-submit", () => ({ submitExecuteSwap: async () => ({ tx_id: "0xexec" }) }))
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

import { POST } from "@/app/api/trade-chain/execute/route"

const post = (body: any, badJson = false) => ({ json: async () => { if (badJson) throw new Error("bad"); return body } }) as any
const state = (over: any = {}) => ({ id: "row1", status: "ready", chain_trade_id: 7, ...over })

beforeEach(() => {
  process.env.RPC_TRADE_ESCROW_ADDRESS = "0xescrow"
  st.user = { id: "u1" }
  st.sel = { data: state(), error: null }
  st.upd = { data: state({ status: "executed" }), error: null }
})

describe("POST /api/trade-chain/execute", () => {
  it("503 when the escrow contract is not configured", async () => {
    delete process.env.RPC_TRADE_ESCROW_ADDRESS
    expect((await POST(post({ trade_match_id: "tm1" }))).status).toBe(503)
  })
  it("401 unauthenticated", async () => {
    st.user = null
    expect((await POST(post({ trade_match_id: "tm1" }))).status).toBe(401)
  })
  it("400 invalid JSON / missing id", async () => {
    expect((await POST(post({}, true))).status).toBe(400)
    expect((await POST(post({}))).status).toBe(400)
  })
  it("404 when the state row is missing", async () => {
    st.sel = { data: null, error: null }
    expect((await POST(post({ trade_match_id: "tm1" }))).status).toBe(404)
  })
  it("500 when the lookup errors", async () => {
    st.sel = { data: null, error: { message: "db down" } }
    expect((await POST(post({ trade_match_id: "tm1" }))).status).toBe(500)
  })
  it("409 when the status is not 'ready'", async () => {
    st.sel = { data: state({ status: "partial_a" }), error: null }
    const res = await POST(post({ trade_match_id: "tm1" }))
    expect(res.status).toBe(409)
    expect((await res.json()).error).toContain("Cannot execute from status='partial_a'")
  })
  it("executes from 'ready' → status becomes 'executed'", async () => {
    const res = await POST(post({ trade_match_id: "tm1" }))
    expect(res.status).toBe(200)
    expect((await res.json()).state.status).toBe("executed")
  })
  it("a null chain_trade_id passes through in stub mode (still executes)", async () => {
    st.sel = { data: state({ chain_trade_id: null }), error: null }
    const res = await POST(post({ trade_match_id: "tm1" }))
    expect(res.status).toBe(200)
  })
  it("500 when the update errors", async () => {
    st.upd = { data: null, error: { message: "update failed" } }
    expect((await POST(post({ trade_match_id: "tm1" }))).status).toBe(500)
  })
})

import { describe, it, expect, beforeEach, vi } from "vitest"

// Deep drive of /api/admin/reclaim-expired-trades (the sibling test only pins
// auth). Shelved behind RPC_TRADE_ESCROW_ADDRESS (503); the janitor loops expired
// open trades, submits the reclaim tx, and flips status→expired. Legs pinned:
// auth, the 503 gate, the query error → 500, the empty short-circuit, a successful
// reclaim, a per-row update error → failures, a submit throw → failures, and the
// GET alias.

const st = vi.hoisted(() => ({
  authed: true,
  rows: { data: [] as any[], error: null as any },
  upd: { error: null as any },
  submitThrows: false,
}))
vi.mock("@/lib/admin-auth", () => ({
  verifyAdminRequest: () => st.authed,
  adminUnauthorizedResponse: () => new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }),
}))
vi.mock("@sentry/nextjs", () => ({ captureException: () => {} }))
vi.mock("@/lib/trade-escrow/fcl-submit", () => ({
  submitReclaimExpired: async () => { if (st.submitThrows) throw new Error("submit down"); return { tx_id: "0xreclaim" } },
}))
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from() {
      let op: "select" | "update" = "select"
      const b: any = {
        select: () => b, update: () => { op = "update"; return b },
        in: () => b, lt: () => b, limit: () => b, eq: () => b,
        then: (resolve: any) => resolve(op === "update" ? st.upd : st.rows),
      }
      return b
    },
  },
}))

import { POST, GET } from "@/app/api/admin/reclaim-expired-trades/route"

const req = () => ({ headers: new Headers(), nextUrl: new URL("https://t/api/admin/reclaim-expired-trades") }) as any
const row = (over: any = {}) => ({ id: "r1", chain_trade_id: 7, status: "ready", ...over })

beforeEach(() => {
  process.env.RPC_TRADE_ESCROW_ADDRESS = "0xescrow"
  st.authed = true
  st.rows = { data: [], error: null }
  st.upd = { error: null }
  st.submitThrows = false
})

describe("/api/admin/reclaim-expired-trades", () => {
  it("401 when not an admin", async () => {
    st.authed = false
    expect((await POST(req())).status).toBe(401)
  })
  it("503 when the escrow contract is not configured", async () => {
    delete process.env.RPC_TRADE_ESCROW_ADDRESS
    expect((await POST(req())).status).toBe(503)
  })
  it("query error → 500", async () => {
    st.rows = { data: null, error: { message: "state down" } }
    expect((await POST(req())).status).toBe(500)
  })
  it("no expired trades → reclaimed 0", async () => {
    const body = await (await POST(req())).json()
    expect(body.reclaimed).toBe(0)
  })
  it("reclaims each expired trade and flips it to expired", async () => {
    st.rows = { data: [row({ id: "a" }), row({ id: "b" })], error: null }
    const body = await (await POST(req())).json()
    expect(body.reclaimed).toBe(2)
    expect(body.candidates).toBe(2)
    expect(body.failures).toEqual([])
  })
  it("a per-row update error is collected into failures (not fatal)", async () => {
    st.rows = { data: [row()], error: null }
    st.upd = { error: { message: "update conflict" } }
    const body = await (await POST(req())).json()
    expect(body.reclaimed).toBe(0)
    expect(body.failures[0]).toMatchObject({ id: "r1", error: "update conflict" })
  })
  it("a submit throw is collected into failures", async () => {
    st.rows = { data: [row()], error: null }
    st.submitThrows = true
    const body = await (await POST(req())).json()
    expect(body.reclaimed).toBe(0)
    expect(body.failures[0].error).toContain("submit down")
  })
  it("GET alias runs the same janitor", async () => {
    st.rows = { data: [row()], error: null }
    const body = await (await GET(req())).json()
    expect(body.reclaimed).toBe(1)
  })
})

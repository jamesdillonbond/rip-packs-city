import { describe, it, expect, beforeEach, vi } from "vitest"
import { NextRequest } from "next/server"

// Route integration test for POST /api/breaks/[id]/validate-recipients.
// Admin-gated (Bearer BREAKS_ADMIN_TOKEN, module-level TOKEN read at import →
// set it via vi.hoisted before import). Beyond the fail-closed 401s this covers
// the break lookup (404/500), the status gate (409), the spots load (empty/500),
// the Flow capability query (502 throw / 502 length-mismatch), and the per-spot
// validation update + failures collection on the happy path.

const h = vi.hoisted(() => {
  process.env.BREAKS_ADMIN_TOKEN = "admin-tok"
  const state: {
    break: { data: any; error: any }
    spots: { data: any; error: any }
    spotUpdate: { error: any }
    fclResult: any
    fclThrow: boolean
  } = { break: { data: null, error: null }, spots: { data: [], error: null }, spotUpdate: { error: null }, fclResult: [], fclThrow: false }
  return { state }
})
const { state } = h

vi.mock("@/lib/supabase", () => {
  const makeBuilder = (table: string) => {
    const b: any = { _isUpdate: false }
    for (const m of ["select", "eq", "order", "in"]) b[m] = () => b
    b.update = () => { b._isUpdate = true; return b }
    b.maybeSingle = async () => (table === "breaks" ? h.state.break : { data: null, error: null })
    b.then = (resolve: any) =>
      resolve(b._isUpdate ? h.state.spotUpdate : table === "break_spots" ? h.state.spots : { data: [], error: null })
    return b
  }
  return { supabaseAdmin: { from: (t: string) => makeBuilder(t) } }
})

vi.mock("@/lib/breaks/server-authz", () => ({ configureFcl: () => {} }))
vi.mock("@onflow/fcl", () => ({
  query: vi.fn(async () => {
    if (h.state.fclThrow) throw new Error("flow rpc down")
    return h.state.fclResult
  }),
}))
vi.mock("@onflow/types", () => ({ Array: () => ({}), Address: {} }))

import { POST } from "@/app/api/breaks/[id]/validate-recipients/route"

function req(auth?: string): NextRequest {
  const headers = new Headers()
  if (auth) headers.set("authorization", auth)
  return new NextRequest("https://t/api/breaks/b1/validate-recipients", { method: "POST", headers })
}
const ctx = { params: Promise.resolve({ id: "b1" }) }
const authed = () => req("Bearer admin-tok")

const spot = (i: number, wallet: string) => ({
  id: `s${i}`, spot_index: i, customer_email: `u${i}@x.com`, customer_wallet: wallet,
})

beforeEach(() => {
  state.break = { data: { id: "b1", status: "selling" }, error: null }
  state.spots = { data: [], error: null }
  state.spotUpdate = { error: null }
  state.fclResult = []
  state.fclThrow = false
})

describe("POST /api/breaks/[id]/validate-recipients", () => {
  it("401s without an admin token", async () => {
    expect((await POST(req(), ctx)).status).toBe(401)
  })
  it("401s with a wrong admin token", async () => {
    expect((await POST(req("Bearer wrong"), ctx)).status).toBe(401)
  })

  it("500s when the break lookup errors", async () => {
    state.break = { data: null, error: { message: "brk boom" } }
    expect((await POST(authed(), ctx)).status).toBe(500)
  })

  it("404s when the break is not found", async () => {
    state.break = { data: null, error: null }
    expect((await POST(authed(), ctx)).status).toBe(404)
  })

  it("409s when the break status is not selling/locked", async () => {
    state.break = { data: { id: "b1", status: "draft" }, error: null }
    const res = await POST(authed(), ctx)
    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(/not in \(selling, locked\)/)
  })

  it("500s when the spots load errors", async () => {
    state.spots = { data: null, error: { message: "spots boom" } }
    expect((await POST(authed(), ctx)).status).toBe(500)
  })

  it("returns validated:0 when there are no spots", async () => {
    state.spots = { data: [], error: null }
    const res = await POST(authed(), ctx)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ validated: 0, failures: [] })
  })

  it("502s when the Flow query throws", async () => {
    state.spots = { data: [spot(0, "0xa")], error: null }
    state.fclThrow = true
    const res = await POST(authed(), ctx)
    expect(res.status).toBe(502)
    expect((await res.json()).error).toMatch(/flow query failed/)
  })

  it("502s when the Flow result length does not match the spots", async () => {
    state.spots = { data: [spot(0, "0xa"), spot(1, "0xb")], error: null }
    state.fclResult = [true] // 1 result, 2 spots
    const res = await POST(authed(), ctx)
    expect(res.status).toBe(502)
    expect((await res.json()).error).toMatch(/length did not match/)
  })

  it("validates each spot and reports the unvalidated ones as failures", async () => {
    state.spots = { data: [spot(0, "0xa"), spot(1, "0xb")], error: null }
    state.fclResult = [true, false] // spot 0 ok, spot 1 has no collection cap
    const res = await POST(authed(), ctx)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.validated).toBe(2)
    expect(body.failures).toHaveLength(1)
    expect(body.failures[0]).toMatchObject({ spot_index: 1, wallet: "0xb", email: "u1@x.com" })
  })

  it("still returns 200 when a per-spot update errors (logged, non-fatal)", async () => {
    state.spots = { data: [spot(0, "0xa")], error: null }
    state.fclResult = [true]
    state.spotUpdate = { error: { message: "update boom" } }
    const res = await POST(authed(), ctx)
    expect(res.status).toBe(200)
    expect((await res.json()).validated).toBe(1)
  })
})

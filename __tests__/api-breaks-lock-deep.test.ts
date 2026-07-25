import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

// Deep drive of POST /api/breaks/[id]/lock (the sibling test only pins auth). Locks
// a selling break: verifies every spot is captured, snapshots the sealed Flow block
// height, picks a target height, and flips status=locked (seeding team_pool for
// team formats). Legs pinned: auth, missing id, the break lookup (404/500/status
// 409), the spots lookup (empty/unpaid 409), the sealed-height fetch failure (502)
// + invalid-height guard, the team-pool seeding branch, and the update-error path.

vi.hoisted(() => { process.env.BREAKS_ADMIN_TOKEN = "brk-tok" })

const st = vi.hoisted(() => ({
  brk: { data: null as any, error: null as any },
  spots: { data: [] as any[], error: null as any },
  upd: { error: null as any },
  updatePatch: null as any,
}))
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from(table: string) {
      let op: "select" | "update" = "select"
      const b: any = {
        select: () => b, update: (patch: any) => { op = "update"; st.updatePatch = patch; return b },
        eq: () => b, order: () => b,
        maybeSingle: async () => st.brk,
        then: (resolve: any) => resolve(table === "break_spots" ? st.spots : st.upd),
      }
      return b
    },
  },
}))
vi.mock("@/lib/breaks/server-authz", () => ({ getFlowAccessNode: () => "http://flow" }))

import { POST } from "@/app/api/breaks/[id]/lock/route"

const post = (id = "b1", auth = "Bearer brk-tok") =>
  [{ headers: new Headers(auth ? { authorization: auth } : {}) } as any, { params: Promise.resolve({ id }) }] as const

let flowMode: "ok" | "notok" | "badheight" = "ok"
function installFetch() {
  vi.stubGlobal("fetch", vi.fn(async () => {
    if (flowMode === "notok") return { ok: false, status: 502, statusText: "bad gw", json: async () => ({}) }
    const height = flowMode === "badheight" ? "-1" : "1000"
    return { ok: true, json: async () => ({ header: { height } }) }
  }))
}
const captured = (spots: any[]) => ({ data: spots, error: null })

beforeEach(() => {
  process.env.BREAKS_ADMIN_TOKEN = "brk-tok"
  st.brk = { data: { id: "b1", status: "selling", format: "standard" }, error: null }
  st.spots = captured([{ spot_index: 0, payment_status: "captured" }, { spot_index: 1, payment_status: "captured" }])
  st.upd = { error: null }
  st.updatePatch = null
  flowMode = "ok"
  installFetch()
})
afterEach(() => vi.unstubAllGlobals())

describe("POST /api/breaks/[id]/lock", () => {
  it("401 with a wrong token", async () => {
    expect((await POST(...post("b1", "Bearer nope"))).status).toBe(401)
  })
  it("400 without an id", async () => {
    expect((await POST(...post(""))).status).toBe(400)
  })
  it("500 when the break lookup errors", async () => {
    st.brk = { data: null, error: { message: "db down" } }
    expect((await POST(...post())).status).toBe(500)
  })
  it("404 when the break is missing", async () => {
    st.brk = { data: null, error: null }
    expect((await POST(...post())).status).toBe(404)
  })
  it("409 when the break is not 'selling'", async () => {
    st.brk = { data: { id: "b1", status: "locked", format: "standard" }, error: null }
    const res = await POST(...post())
    expect(res.status).toBe(409)
    expect((await res.json()).error).toContain("is not 'selling'")
  })
  it("409 when no spots are sold", async () => {
    st.spots = { data: [], error: null }
    const res = await POST(...post())
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe("no spots sold")
  })
  it("409 when some spots are not captured, listing the pending ones", async () => {
    st.spots = captured([{ spot_index: 0, payment_status: "captured" }, { spot_index: 1, payment_status: "pending" }])
    const res = await POST(...post())
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error).toContain("not yet captured")
    expect(body.pending).toEqual([{ spot_index: 1, payment_status: "pending" }])
  })
  it("502 when the sealed-height fetch fails", async () => {
    flowMode = "notok"
    expect((await POST(...post())).status).toBe(502)
  })
  it("502 when the sealed block height is invalid", async () => {
    flowMode = "badheight"
    expect((await POST(...post())).status).toBe(502)
  })
  it("locks a standard break → ok with heights, no team_pool", async () => {
    const res = await POST(...post())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.current_height).toBe(1000)
    expect(body.target_height).toBe(1010)
    expect(st.updatePatch.status).toBe("locked")
    expect(st.updatePatch.team_pool).toBeUndefined()
  })
  it("a team_draft break also seeds the team_pool", async () => {
    st.brk = { data: { id: "b1", status: "selling", format: "team_draft" }, error: null }
    await POST(...post())
    expect(Array.isArray(st.updatePatch.team_pool)).toBe(true)
    expect(st.updatePatch.team_pool.length).toBe(30) // canonical NBA teams
  })
  it("500 when the lock update errors", async () => {
    st.upd = { error: { message: "update failed" } }
    expect((await POST(...post())).status).toBe(500)
  })
})

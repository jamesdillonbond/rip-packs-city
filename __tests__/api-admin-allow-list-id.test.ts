import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { adminReq } from "./helpers/admin-req"

// Route integration test for PATCH /api/admin/allow-list/[id]. Bearer-gated via
// verifyAdminRequest. Covers the fail-closed 401 plus the param 400s that run
// before any RPC (invalid uuid, invalid action), AND the 2xx success path: an
// authed valid action drives allow_list_decide (mocked {ok:true}) then re-reads
// and returns the decided row.

const { ROW } = vi.hoisted(() => ({
  ROW: {
    id: "11111111-1111-1111-1111-111111111111",
    email: "beta@example.com",
    status: "active",
    prewarm_status: "pending",
  },
}))
vi.mock("@/lib/supabase", () => {
  const sb: any = {
    rpc: async () => ({ data: { ok: true }, error: null }),
    from: () => sb,
    select: () => sb,
    eq: () => sb,
    maybeSingle: async () => ({ data: ROW, error: null }),
  }
  return { supabaseAdmin: sb }
})

import { PATCH } from "@/app/api/admin/allow-list/[id]/route"

const UUID = "11111111-1111-1111-1111-111111111111"
const ctx = (id: string) => ({ params: Promise.resolve({ id }) })

beforeEach(() => {
  delete process.env.RPC_ADMIN_TOKEN
})
afterEach(() => {
  delete process.env.RPC_ADMIN_TOKEN
})

describe("PATCH /api/admin/allow-list/[id]", () => {
  it("401s when RPC_ADMIN_TOKEN is unset (fail-closed)", async () => {
    const res = await PATCH(adminReq(`https://t/api/admin/allow-list/${UUID}`), ctx(UUID))
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe("Unauthorized")
  })

  it("400s on a non-uuid id for an authed request", async () => {
    process.env.RPC_ADMIN_TOKEN = "secret"
    const res = await PATCH(
      adminReq("https://t/api/admin/allow-list/bad", { authorization: "Bearer secret", body: { action: "approve" } }),
      ctx("bad")
    )
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("Invalid id")
  })

  it("400s on an unknown action for an authed request", async () => {
    process.env.RPC_ADMIN_TOKEN = "secret"
    const res = await PATCH(
      adminReq(`https://t/api/admin/allow-list/${UUID}`, { authorization: "Bearer secret", body: { action: "nope" } }),
      ctx(UUID)
    )
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain("action must be one of")
  })

  it("200s and returns the decided row on an authed valid action", async () => {
    process.env.RPC_ADMIN_TOKEN = "secret"
    const res = await PATCH(
      adminReq(`https://t/api/admin/allow-list/${UUID}`, { authorization: "Bearer secret", body: { action: "approve" } }),
      ctx(UUID)
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.row.id).toBe(ROW.id)
    expect(body.row.status).toBe("active")
  })
})

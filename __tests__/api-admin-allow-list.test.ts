import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { adminReq } from "./helpers/admin-req"

// Route integration test for GET /api/admin/allow-list. Bearer-gated against
// RPC_ADMIN_TOKEN via verifyAdminRequest. Highest-value assertion is the
// fail-closed 401 when RPC_ADMIN_TOKEN is unset; the authed happy path mocks
// supabaseAdmin (chained .from().select().order().limit()) and pins the
// status-rank sort + counts rollup.

const state: { res: { data: any; error: any } } = { res: { data: [], error: null } }

vi.mock("@/lib/supabase", () => {
  const b: any = {
    select: () => b,
    order: () => b,
    limit: async () => state.res,
  }
  return { supabaseAdmin: { from: () => b } }
})

import { GET } from "@/app/api/admin/allow-list/route"

beforeEach(() => {
  state.res = { data: [], error: null }
  delete process.env.RPC_ADMIN_TOKEN
})
afterEach(() => {
  delete process.env.RPC_ADMIN_TOKEN
})

describe("GET /api/admin/allow-list", () => {
  it("401s when RPC_ADMIN_TOKEN is unset (fail-closed)", async () => {
    const res = await GET(adminReq("https://t/api/admin/allow-list"))
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe("Unauthorized")
  })

  it("401s with a wrong bearer even when the token is configured", async () => {
    process.env.RPC_ADMIN_TOKEN = "secret"
    const res = await GET(
      adminReq("https://t/api/admin/allow-list", { authorization: "Bearer nope" })
    )
    expect(res.status).toBe(401)
  })

  it("returns rows sorted by status rank with counts for an authed request", async () => {
    process.env.RPC_ADMIN_TOKEN = "secret"
    state.res = {
      data: [
        { id: "1", status: "active", created_at: "2026-07-10T00:00:00Z" },
        { id: "2", status: "pending", created_at: "2026-07-09T00:00:00Z" },
        { id: "3", status: "pending", created_at: "2026-07-11T00:00:00Z" },
      ],
      error: null,
    }
    const res = await GET(
      adminReq("https://t/api/admin/allow-list", { authorization: "Bearer secret" })
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    // pending (rank 0) before active (rank 2); within pending, newest first.
    expect(body.rows.map((r: any) => r.id)).toEqual(["3", "2", "1"])
    expect(body.counts).toMatchObject({ pending: 2, active: 1 })
  })
})

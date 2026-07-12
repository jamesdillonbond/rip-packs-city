import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { adminReq } from "./helpers/admin-req"

// Route integration test for POST /api/admin/allow-list/prewarm-now. Bearer-
// gated via verifyAdminRequest (RPC_ADMIN_TOKEN, NOT CRON_SECRET). Covers the
// fail-closed 401 and the param 400 for a non-uuid id, both of which return
// before any supabase / seeder work. The prewarm processor is mocked at import.

const { ROW } = vi.hoisted(() => ({
  ROW: {
    id: "22222222-2222-2222-2222-222222222222",
    email: "beta@example.com",
    status: "active",
    prewarm_status: "pending",
    prewarm_attempts: 0,
  },
}))
vi.mock("@/lib/supabase", () => {
  const sb: any = {
    rpc: async () => ({ data: null, error: null }),
    from: () => sb,
    select: () => sb,
    eq: () => sb,
    update: () => sb,
    maybeSingle: async () => ({ data: ROW, error: null }),
  }
  return { supabaseAdmin: sb }
})
vi.mock("@/lib/allow-list/prewarm", () => ({
  processSinglePrewarmRow: async () => ({ id: "22222222-2222-2222-2222-222222222222", finish_status: "done", welcome_sent: true }),
}))

import { POST } from "@/app/api/admin/allow-list/prewarm-now/route"

beforeEach(() => {
  delete process.env.RPC_ADMIN_TOKEN
})
afterEach(() => {
  delete process.env.RPC_ADMIN_TOKEN
})

describe("POST /api/admin/allow-list/prewarm-now", () => {
  it("401s when RPC_ADMIN_TOKEN is unset (fail-closed)", async () => {
    const res = await POST(adminReq("https://t/api/admin/allow-list/prewarm-now", { body: { id: "x" } }))
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe("Unauthorized")
  })

  it("400s on a non-uuid id for an authed request", async () => {
    process.env.RPC_ADMIN_TOKEN = "secret"
    const res = await POST(
      adminReq("https://t/api/admin/allow-list/prewarm-now", { authorization: "Bearer secret", body: { id: "not-a-uuid" } })
    )
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("id must be a uuid")
  })

  it("200s and returns the prewarm outcome for an authed active row", async () => {
    process.env.RPC_ADMIN_TOKEN = "secret"
    const res = await POST(
      adminReq("https://t/api/admin/allow-list/prewarm-now", {
        authorization: "Bearer secret",
        body: { id: "22222222-2222-2222-2222-222222222222" },
      })
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.outcome.finish_status).toBe("done")
  })
})

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { adminReq } from "./helpers/admin-req"

// Route integration test for POST /api/admin/allow-list/prewarm-now. Bearer-
// gated via verifyAdminRequest (RPC_ADMIN_TOKEN, NOT CRON_SECRET). Covers the
// fail-closed 401 and the param 400 for a non-uuid id, both of which return
// before any supabase / seeder work. The prewarm processor is mocked at import.

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: { rpc: async () => ({ data: null, error: null }) } }))
vi.mock("@/lib/allow-list/prewarm", () => ({ processSinglePrewarmRow: async () => ({ id: "x" }) }))

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
})

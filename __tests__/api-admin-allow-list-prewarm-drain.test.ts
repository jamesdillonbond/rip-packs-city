import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { adminReq } from "./helpers/admin-req"

// Route integration test for POST /api/admin/allow-list/prewarm-drain. This
// route is gated on CRON_SECRET (not RPC_ADMIN_TOKEN). Two fail-closed shapes:
// a missing CRON_SECRET is a 500 misconfig, and a configured secret with the
// wrong bearer is a 401. The per-row processor is mocked so importing the route
// never pulls a live seeder.

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: { rpc: async () => ({ data: [], error: null }) } }))
vi.mock("@/lib/allow-list/prewarm", () => ({ processSinglePrewarmRow: async () => ({ id: "x" }) }))

import { POST } from "@/app/api/admin/allow-list/prewarm-drain/route"

beforeEach(() => {
  delete process.env.CRON_SECRET
})
afterEach(() => {
  delete process.env.CRON_SECRET
})

describe("POST /api/admin/allow-list/prewarm-drain", () => {
  it("500s when CRON_SECRET is not configured", async () => {
    const res = await POST(adminReq("https://t/api/admin/allow-list/prewarm-drain"))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("CRON_SECRET not configured")
  })

  it("401s when the bearer does not match CRON_SECRET", async () => {
    process.env.CRON_SECRET = "cron-secret"
    const res = await POST(
      adminReq("https://t/api/admin/allow-list/prewarm-drain", { authorization: "Bearer wrong" })
    )
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe("unauthorized")
  })
})

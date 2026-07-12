import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { adminReq } from "./helpers/admin-req"

// Route integration test for GET /api/admin/analytics-overview. Auth accepts
// Bearer INGEST_SECRET_TOKEN OR RPC_ADMIN_TOKEN; both unset => fail-closed 401.
// Authed happy path proxies the SECDEF get_admin_analytics_overview() RPC.

const rpc: { data: any; error: any } = { data: null, error: null }

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: { rpc: async () => ({ data: rpc.data, error: rpc.error }) },
}))

import { GET } from "@/app/api/admin/analytics-overview/route"

beforeEach(() => {
  rpc.data = null
  rpc.error = null
  delete process.env.INGEST_SECRET_TOKEN
  delete process.env.RPC_ADMIN_TOKEN
})
afterEach(() => {
  delete process.env.INGEST_SECRET_TOKEN
  delete process.env.RPC_ADMIN_TOKEN
})

describe("GET /api/admin/analytics-overview", () => {
  it("401s when neither token is configured (fail-closed)", async () => {
    const res = await GET(adminReq("https://t/api/admin/analytics-overview"))
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe("Unauthorized")
  })

  it("returns the RPC payload for an authed request", async () => {
    process.env.RPC_ADMIN_TOKEN = "secret"
    rpc.data = { active_users: 42 }
    const res = await GET(
      adminReq("https://t/api/admin/analytics-overview", { authorization: "Bearer secret" })
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ active_users: 42 })
  })

  it("500s on an RPC error for an authed request", async () => {
    process.env.INGEST_SECRET_TOKEN = "ingest"
    rpc.error = { message: "db down" }
    const res = await GET(
      adminReq("https://t/api/admin/analytics-overview", { authorization: "Bearer ingest" })
    )
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("db down")
  })
})

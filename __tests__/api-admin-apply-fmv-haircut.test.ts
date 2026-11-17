import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { adminReq } from "./helpers/admin-req"

// Route integration test for POST /api/admin/apply-fmv-haircut. Bearer-gated via
// verifyAdminRequest. Fail-closed 401, plus the param 400s (missing/invalid
// mode, unknown collection) which run before any RPC. The dry-run RPC is mocked
// so the authed 400 branches never touch the network.

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    rpc: async () => ({
      data: [{ rows_examined: 12, rows_haircut: 3, total_dollars_removed: 41.5 }],
      error: null,
    }),
  },
}))

import { POST } from "@/app/api/admin/apply-fmv-haircut/route"

beforeEach(() => {
  delete process.env.RPC_ADMIN_TOKEN
})
afterEach(() => {
  delete process.env.RPC_ADMIN_TOKEN
})

describe("POST /api/admin/apply-fmv-haircut", () => {
  it("401s when RPC_ADMIN_TOKEN is unset (fail-closed)", async () => {
    const res = await POST(adminReq("https://t/api/admin/apply-fmv-haircut?mode=dry"))
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe("Unauthorized")
  })

  it("400s when mode is missing/invalid for an authed request", async () => {
    process.env.RPC_ADMIN_TOKEN = "secret"
    const res = await POST(
      adminReq("https://t/api/admin/apply-fmv-haircut", { authorization: "Bearer secret" })
    )
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain("mode query param")
  })

  it("400s on an unknown collection for an authed request", async () => {
    process.env.RPC_ADMIN_TOKEN = "secret"
    const res = await POST(
      adminReq("https://t/api/admin/apply-fmv-haircut?mode=dry&collection=xxx", { authorization: "Bearer secret" })
    )
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain("unknown collection")
  })

  it("200s a dry-run preview with the RPC-derived haircut counts (authed)", async () => {
    process.env.RPC_ADMIN_TOKEN = "secret"
    const res = await POST(
      adminReq("https://t/api/admin/apply-fmv-haircut?mode=dry&collection=topshot", { authorization: "Bearer secret" })
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.mode).toBe("dry")
    expect(body.rows_examined).toBe(12)
    expect(body.rows_haircut).toBe(3)
    expect(body.total_dollars_removed).toBe(41.5)
  })
})

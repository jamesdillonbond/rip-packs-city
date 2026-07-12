import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { adminReq } from "./helpers/admin-req"

// Route integration test for /api/admin/backfill-pinnacle-sales-render-id
// (GET + POST share handle()). Bearer-gated via verifyAdminRequest
// (RPC_ADMIN_TOKEN). None set => fail-closed 401 on both verbs.

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: { rpc: async () => ({ data: null, error: null }) } }))

import { GET, POST } from "@/app/api/admin/backfill-pinnacle-sales-render-id/route"

beforeEach(() => {
  delete process.env.RPC_ADMIN_TOKEN
})
afterEach(() => {
  delete process.env.RPC_ADMIN_TOKEN
})

describe("/api/admin/backfill-pinnacle-sales-render-id", () => {
  it("GET 401s when RPC_ADMIN_TOKEN is unset (fail-closed)", async () => {
    const res = await GET(adminReq("https://t/api/admin/backfill-pinnacle-sales-render-id"))
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe("Unauthorized")
  })

  it("POST 401s with a wrong bearer even when the token is configured", async () => {
    process.env.RPC_ADMIN_TOKEN = "secret"
    const res = await POST(adminReq("https://t/api/admin/backfill-pinnacle-sales-render-id", { authorization: "Bearer nope" }))
    expect(res.status).toBe(401)
  })
})

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

  it("200s with 0 attempted when there are no unresolved render ids (authed)", async () => {
    // pinnacle_sales_unresolved_render_nft_ids mocked null/[] → no GQL fan-out.
    process.env.RPC_ADMIN_TOKEN = "secret"
    const res = await GET(adminReq("https://t/api/admin/backfill-pinnacle-sales-render-id", { authorization: "Bearer secret" }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.distinct_nft_attempted).toBe(0)
    expect(body.pipeline).toBe("pinnacle-sales-render-id-backfill")
  })
})

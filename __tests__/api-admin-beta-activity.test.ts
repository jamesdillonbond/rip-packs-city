import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { adminReq } from "./helpers/admin-req"

// Route integration test for GET /api/admin/beta-activity. Auth accepts Bearer
// RPC_ADMIN_TOKEN OR INGEST_SECRET_TOKEN (both request-time). None set =>
// fail-closed 401 with a lower-case "unauthorized" body. The authed path joins
// three service-role tables with no simple mock seam.

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: { from: () => ({}) } }))

import { GET } from "@/app/api/admin/beta-activity/route"

beforeEach(() => {
  delete process.env.RPC_ADMIN_TOKEN
  delete process.env.INGEST_SECRET_TOKEN
})
afterEach(() => {
  delete process.env.RPC_ADMIN_TOKEN
  delete process.env.INGEST_SECRET_TOKEN
})

describe("GET /api/admin/beta-activity", () => {
  it("401s when no token is configured (fail-closed)", async () => {
    const res = await GET(adminReq("https://t/api/admin/beta-activity"))
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe("unauthorized")
  })

  it("401s with a wrong bearer even when a token is configured", async () => {
    process.env.RPC_ADMIN_TOKEN = "secret"
    const res = await GET(adminReq("https://t/api/admin/beta-activity", { authorization: "Bearer nope" }))
    expect(res.status).toBe(401)
  })
})

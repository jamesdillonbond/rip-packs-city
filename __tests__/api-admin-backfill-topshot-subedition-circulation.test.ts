import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { adminReq } from "./helpers/admin-req"

// Route integration test for /api/admin/backfill-topshot-subedition-circulation
// (GET + POST share handle()). Auth via authed(): verifyAdminRequest OR
// INGEST_SECRET_TOKEN OR CRON_SECRET (all request-time). None set =>
// fail-closed 401 on both verbs.

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: { rpc: async () => ({ data: null, error: null }) } }))

import { GET, POST } from "@/app/api/admin/backfill-topshot-subedition-circulation/route"

beforeEach(() => {
  delete process.env.RPC_ADMIN_TOKEN
  delete process.env.INGEST_SECRET_TOKEN
  delete process.env.CRON_SECRET
})
afterEach(() => {
  delete process.env.RPC_ADMIN_TOKEN
  delete process.env.INGEST_SECRET_TOKEN
  delete process.env.CRON_SECRET
})

describe("/api/admin/backfill-topshot-subedition-circulation", () => {
  it("GET 401s when no secret is configured (fail-closed)", async () => {
    const res = await GET(adminReq("https://t/api/admin/backfill-topshot-subedition-circulation"))
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe("Unauthorized")
  })

  it("POST 401s with a wrong bearer even when a secret is configured", async () => {
    process.env.CRON_SECRET = "cron"
    const res = await POST(adminReq("https://t/api/admin/backfill-topshot-subedition-circulation", { authorization: "Bearer nope" }))
    expect(res.status).toBe(401)
  })
})

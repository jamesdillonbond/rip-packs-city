import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { adminReq } from "./helpers/admin-req"

// Route integration test for /api/admin/backfill-pinnacle-catalog (GET + POST
// share handle()). Auth via authed(): verifyAdminRequest OR INGEST_SECRET_TOKEN
// OR CRON_SECRET (all read at request time). None set => fail-closed 401. The
// catalog + floor sweep pages the Pinnacle Studio GraphQL inside next/server
// after() (stubbed no-op), so the authed path returns an immediate 202 accept
// that is observable without the GQL fan-out.

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: () => {} }
})
vi.mock("@/lib/supabase", () => ({ supabaseAdmin: { rpc: async () => ({ data: null, error: null }) } }))

import { GET, POST } from "@/app/api/admin/backfill-pinnacle-catalog/route"

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

describe("/api/admin/backfill-pinnacle-catalog", () => {
  it("GET 401s when no secret is configured (fail-closed)", async () => {
    const res = await GET(adminReq("https://t/api/admin/backfill-pinnacle-catalog"))
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe("Unauthorized")
  })

  it("POST 401s with a wrong bearer even when a secret is configured", async () => {
    process.env.INGEST_SECRET_TOKEN = "ingest"
    const res = await POST(adminReq("https://t/api/admin/backfill-pinnacle-catalog", { authorization: "Bearer nope" }))
    expect(res.status).toBe(401)
  })

  it("202s the accepted envelope when authed (catalog sweep deferred to after())", async () => {
    process.env.RPC_ADMIN_TOKEN = "secret"
    const res = await POST(adminReq("https://t/api/admin/backfill-pinnacle-catalog", { authorization: "Bearer secret" }))
    expect(res.status).toBe(202)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.accepted).toBe(true)
    expect(body.pipeline).toBe("pinnacle-catalog-backfill")
  })
})

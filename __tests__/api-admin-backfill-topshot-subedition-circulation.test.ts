import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { adminReq } from "./helpers/admin-req"

// Route integration test for /api/admin/backfill-topshot-subedition-circulation
// (GET + POST share handle()). Auth via authed(): verifyAdminRequest OR
// INGEST_SECRET_TOKEN OR CRON_SECRET (all request-time). None set =>
// fail-closed 401. Success path: the :: editions select is mocked empty and the
// Top Shot proxy fetch (fetchPage) is stubbed to an empty single page, so the
// sweep terminates catalog_exhausted and returns a synchronous 200.

vi.mock("@/lib/supabase", () => {
  const sb: any = {
    from: () => sb,
    select: () => sb,
    eq: () => sb,
    like: () => sb,
    not: () => sb,
    order: () => sb,
    update: () => sb,
    insert: async () => ({ data: null, error: null }),
    upsert: async () => ({ data: null, error: null }),
    range: async () => ({ data: [], error: null }),
  }
  return { supabaseAdmin: sb }
})

beforeEach(() => {
  delete process.env.RPC_ADMIN_TOKEN
  delete process.env.INGEST_SECRET_TOKEN
  delete process.env.CRON_SECRET
  // Stub the Top Shot proxy fetch (fetchPage) to a single empty page so the
  // catalog sweep exhausts immediately without live GraphQL.
  vi.stubGlobal("fetch", async () => ({
    ok: true,
    json: async () => ({ data: { searchMarketplaceEditions: { data: { searchSummary: { data: { data: [] }, pagination: { rightCursor: null } } } } } }),
  }))
})
afterEach(() => {
  delete process.env.RPC_ADMIN_TOKEN
  delete process.env.INGEST_SECRET_TOKEN
  delete process.env.CRON_SECRET
  vi.unstubAllGlobals()
})

import { GET, POST } from "@/app/api/admin/backfill-topshot-subedition-circulation/route"

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

  it("200s and exhausts the catalog with 0 needed triples (authed)", async () => {
    process.env.RPC_ADMIN_TOKEN = "secret"
    const res = await GET(adminReq("https://t/api/admin/backfill-topshot-subedition-circulation", { authorization: "Bearer secret" }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.needed_triples).toBe(0)
    expect(body.pipeline).toBeTruthy()
  })
})

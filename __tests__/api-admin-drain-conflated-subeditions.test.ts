import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { adminReq } from "./helpers/admin-req"

// Route integration test for /api/admin/drain-conflated-subeditions (GET + POST
// share handle()). Auth via authed(): verifyAdminRequest OR INGEST_SECRET_TOKEN
// OR CRON_SECRET OR RPC_ADMIN_TOKEN (all request-time). None set =>
// fail-closed 401 on both verbs.

vi.mock("@/lib/supabase", () => {
  const sb: any = {
    rpc: async () => ({ data: 0, error: null }),
    from: () => sb,
    insert: async () => ({ data: null, error: null }),
  }
  return { supabaseAdmin: sb }
})

import { GET, POST } from "@/app/api/admin/drain-conflated-subeditions/route"

beforeEach(() => {
  delete process.env.RPC_ADMIN_TOKEN
  delete process.env.INGEST_SECRET_TOKEN
  delete process.env.CRON_SECRET
  // The edge-fn trigger step reads INGEST_SECRET_TOKEN; unset it so
  // triggerSubeditionBackfill short-circuits to "skipped:no_env" (no fetch).
  vi.stubGlobal("fetch", async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => "" }))
})
afterEach(() => {
  delete process.env.RPC_ADMIN_TOKEN
  delete process.env.INGEST_SECRET_TOKEN
  delete process.env.CRON_SECRET
  vi.unstubAllGlobals()
})

describe("/api/admin/drain-conflated-subeditions", () => {
  it("GET 401s when no secret is configured (fail-closed)", async () => {
    const res = await GET(adminReq("https://t/api/admin/drain-conflated-subeditions"))
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe("Unauthorized")
  })

  it("POST 401s with a wrong bearer even when a secret is configured", async () => {
    process.env.INGEST_SECRET_TOKEN = "ingest"
    const res = await POST(adminReq("https://t/api/admin/drain-conflated-subeditions", { authorization: "Bearer nope" }))
    expect(res.status).toBe(401)
  })

  it("200s the orchestrator envelope when authed (all seed/remap RPCs mocked)", async () => {
    process.env.RPC_ADMIN_TOKEN = "secret"
    const res = await POST(adminReq("https://t/api/admin/drain-conflated-subeditions", { authorization: "Bearer secret" }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.pipeline).toBe("drain-conflated-subeditions")
  })
})

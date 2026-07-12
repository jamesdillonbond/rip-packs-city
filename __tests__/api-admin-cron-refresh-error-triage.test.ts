import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { adminReq } from "./helpers/admin-req"

// Route integration test for POST /api/admin/cron/refresh-error-triage. Gated on
// Bearer INGEST_SECRET_TOKEN (request-time). None set => fail-closed 401 with an
// {ok:false} envelope. The authed path defers the rebuild into next/server
// after() and returns 202, so it is not exercised here.

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: { rpc: async () => ({ data: null, error: null }) } }))

import { POST } from "@/app/api/admin/cron/refresh-error-triage/route"

beforeEach(() => {
  delete process.env.INGEST_SECRET_TOKEN
})
afterEach(() => {
  delete process.env.INGEST_SECRET_TOKEN
})

describe("POST /api/admin/cron/refresh-error-triage", () => {
  it("401s when INGEST_SECRET_TOKEN is unset (fail-closed)", async () => {
    const res = await POST(adminReq("https://t/api/admin/cron/refresh-error-triage"))
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.ok).toBe(false)
    expect(body.error).toBe("Unauthorized")
  })

  it("401s with a wrong bearer even when the token is configured", async () => {
    process.env.INGEST_SECRET_TOKEN = "ingest"
    const res = await POST(adminReq("https://t/api/admin/cron/refresh-error-triage", { authorization: "Bearer nope" }))
    expect(res.status).toBe(401)
  })
})

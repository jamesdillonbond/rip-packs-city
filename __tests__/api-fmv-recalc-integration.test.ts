import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"
import { makeSupabaseFixture } from "./helpers/route-harness"

// Route-integration test for POST/GET /api/fmv-recalc driving the pre-work path:
// the misconfigured-token 500, the unauthorized 401, and the authorized ack
// (ok:true). The heavy recompute is deferred to after(), which is stubbed to a
// no-op so the handler returns its immediate 202-style ack without running the
// live FMV sweep; the cursor read is served by makeSupabaseFixture.

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: () => {} }
})
vi.mock("@/lib/supabase", () => ({ supabaseAdmin: makeSupabaseFixture({}) }))

const { POST, GET } = await import("@/app/api/fmv-recalc/route")

function req(token?: string): NextRequest {
  const headers = new Headers({ "content-type": "application/json" })
  if (token) headers.set("authorization", `Bearer ${token}`)
  return new NextRequest("https://t/api/fmv-recalc", { method: "POST", headers, body: "{}" })
}

beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "ingest-secret"
  delete process.env.CRON_SECRET
})
afterEach(() => {
  process.env.INGEST_SECRET_TOKEN = "ingest-secret"
})

describe("POST /api/fmv-recalc — auth + ack", () => {
  it("500s when INGEST_SECRET_TOKEN is not configured", async () => {
    delete process.env.INGEST_SECRET_TOKEN
    const res = await POST(req("anything"))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toContain("INGEST_SECRET_TOKEN")
  })

  it("401s on a wrong bearer token", async () => {
    const res = await POST(req("wrong"))
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe("Unauthorized")
  })

  it("acks ok:true on a valid INGEST token (heavy work deferred to after())", async () => {
    const res = await POST(req("ingest-secret"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.message).toBe("FMV recalc triggered")
  })

  it("also authorizes via CRON_SECRET", async () => {
    process.env.CRON_SECRET = "cron-secret"
    const res = await POST(req("cron-secret"))
    expect(res.status).toBe(200)
    expect((await res.json()).ok).toBe(true)
  })

  it("GET delegates to POST (browser-testing path)", async () => {
    const res = await GET(req("ingest-secret"))
    expect(res.status).toBe(200)
    expect((await res.json()).ok).toBe(true)
  })
})

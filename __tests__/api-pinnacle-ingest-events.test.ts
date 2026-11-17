import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for POST /api/pinnacle/ingest-events.
// Auth is call-time: header must equal `Bearer ${process.env.CRON_SECRET}`,
// else 401 (checked before any ingest). createClient(@supabase/supabase-js) runs
// at import time, so it is mocked to avoid a real-URL throw; the ingest itself
// (@/lib/pinnacle/flow-events) is mocked for the one happy path.

const ingest: { result: any; throwErr: Error | null } = { result: null, throwErr: null }

vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({}) }))
vi.mock("@/lib/pinnacle/flow-events", () => ({
  ingestPinnacleSalesEvents: async () => {
    if (ingest.throwErr) throw ingest.throwErr
    return ingest.result
  },
}))

import { POST } from "@/app/api/pinnacle/ingest-events/route"

const req = (auth?: string) =>
  ({
    headers: new Headers(auth ? { authorization: auth } : {}),
    json: async () => ({}),
  }) as any

beforeEach(() => {
  process.env.CRON_SECRET = "test-cron-secret"
  ingest.result = { sales_ingested: 0, new_cursor: 0, errors: [] }
  ingest.throwErr = null
})

describe("POST /api/pinnacle/ingest-events", () => {
  it("401s with a wrong bearer token", async () => {
    const res = await POST(req("Bearer wrong"))
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe("Unauthorized")
  })

  it("401s with no authorization header", async () => {
    expect((await POST(req())).status).toBe(401)
  })

  it("ingests and returns status ok with the matching CRON_SECRET", async () => {
    ingest.result = { sales_ingested: 3, new_cursor: 12345, errors: [] }
    const res = await POST(req("Bearer test-cron-secret"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe("ok")
    expect(body.sales_ingested).toBe(3)
    expect(body.new_cursor).toBe(12345)
  })

  it("500s when the ingest throws", async () => {
    ingest.throwErr = new Error("boom")
    const res = await POST(req("Bearer test-cron-secret"))
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.status).toBe("error")
    expect(body.error).toBe("boom")
  })
})

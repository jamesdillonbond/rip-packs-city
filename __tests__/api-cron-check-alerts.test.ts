import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { makeReq } from "./cron-req-helper"

// Route integration test for /api/cron/check-alerts (GET + POST share one
// handler). RETIRED 2026-07-12: this is now an auth-gated no-op. Auth read at
// REQUEST time — accepts Bearer INGEST_SECRET_TOKEN / CRON_SECRET only, 401ing
// otherwise. The 200 body is a static retirement notice { deprecated:true, ... }
// and NEVER sends a notification (no DB seam to mock); we assert deprecated:true.

import { POST, GET } from "@/app/api/cron/check-alerts/route"

const url = "https://t/api/cron/check-alerts"
const savedIngest = process.env.INGEST_SECRET_TOKEN
const savedCron = process.env.CRON_SECRET

beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "test-ingest-secret"
  process.env.CRON_SECRET = "test-cron-secret"
})

afterEach(() => {
  if (savedIngest === undefined) delete process.env.INGEST_SECRET_TOKEN
  else process.env.INGEST_SECRET_TOKEN = savedIngest
  if (savedCron === undefined) delete process.env.CRON_SECRET
  else process.env.CRON_SECRET = savedCron
})

describe("POST /api/cron/check-alerts", () => {
  it("401s with no authorization header", async () => {
    expect((await POST(makeReq({ url }))).status).toBe(401)
  })

  it("401s with a wrong bearer token", async () => {
    expect((await POST(makeReq({ url, auth: "Bearer wrong-token" }))).status).toBe(401)
  })
})

describe("POST /api/cron/check-alerts — success path (retired no-op)", () => {
  it("200s and reports the retirement notice with the INGEST bearer token", async () => {
    const res = await POST(makeReq({ url, auth: "Bearer test-ingest-secret" }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.deprecated).toBe(true)
    expect(body.notifications_sent).toBe(0)
    expect(body.canonical).toContain("/api/cron/alerts-dispatch")
  })

  it("200s with the CRON_SECRET bearer token", async () => {
    const res = await POST(makeReq({ url, auth: "Bearer test-cron-secret" }))
    expect(res.status).toBe(200)
    expect((await res.json()).deprecated).toBe(true)
  })

  it("GET alias reaches the same 200 no-op when authed", async () => {
    const res = await GET(makeReq({ url, method: "GET", auth: "Bearer test-ingest-secret" }))
    expect(res.status).toBe(200)
    expect((await res.json()).deprecated).toBe(true)
  })
})

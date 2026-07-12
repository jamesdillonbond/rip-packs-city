import { describe, it, expect, beforeEach } from "vitest"

// Route integration test for POST /api/cron/check-alerts (GET and POST share one
// handler). Fail-closed auth: it accepts Bearer INGEST_SECRET_TOKEN /
// CRON_SECRET only, 401ing otherwise before scanning fmv_alerts. We pin that.

const req = (auth?: string) =>
  ({
    headers: new Headers(auth ? { authorization: auth } : {}),
    nextUrl: new URL("https://t/api/cron/check-alerts"),
  }) as any

import { POST } from "@/app/api/cron/check-alerts/route"

beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "test-ingest-secret"
  process.env.CRON_SECRET = "test-cron-secret"
})

describe("POST /api/cron/check-alerts", () => {
  it("401s with no authorization header", async () => {
    expect((await POST(req())).status).toBe(401)
  })

  it("401s with a wrong bearer token", async () => {
    expect((await POST(req("Bearer wrong-token"))).status).toBe(401)
  })
})

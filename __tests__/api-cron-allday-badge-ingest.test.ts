import { describe, it, expect, beforeEach } from "vitest"

// Route integration test for POST /api/cron/allday-badge-ingest.
// Fail-closed auth: the POST handler accepts Bearer INGEST_SECRET_TOKEN or
// CRON_SECRET only, returning 401 otherwise before any badge ingest. We pin the
// guard.

const req = (auth?: string) =>
  ({
    headers: new Headers(auth ? { authorization: auth } : {}),
    nextUrl: new URL("https://t/api/cron/allday-badge-ingest"),
  }) as any

import { POST } from "@/app/api/cron/allday-badge-ingest/route"

beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "test-ingest-secret"
  process.env.CRON_SECRET = "test-cron-secret"
})

describe("POST /api/cron/allday-badge-ingest", () => {
  it("401s with no authorization header", async () => {
    expect((await POST(req())).status).toBe(401)
  })

  it("401s with a wrong bearer token", async () => {
    expect((await POST(req("Bearer wrong-token"))).status).toBe(401)
  })
})

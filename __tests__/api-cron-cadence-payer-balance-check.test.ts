import { describe, it, expect, beforeEach } from "vitest"

// Route integration test for POST /api/cron/cadence-payer-balance-check.
// Fail-closed auth: authorized() accepts Bearer INGEST_SECRET_TOKEN /
// CRON_SECRET or ?token=, returning 401 otherwise before any Flow REST read. If
// INGEST_SECRET_TOKEN is unset authorized() returns false too. We pin the guard.

const req = (auth?: string) =>
  ({
    headers: new Headers(auth ? { authorization: auth } : {}),
    nextUrl: new URL("https://t/api/cron/cadence-payer-balance-check"),
  }) as any

import { POST } from "@/app/api/cron/cadence-payer-balance-check/route"

beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "test-ingest-secret"
  process.env.CRON_SECRET = "test-cron-secret"
})

describe("POST /api/cron/cadence-payer-balance-check", () => {
  it("401s with no authorization header", async () => {
    expect((await POST(req())).status).toBe(401)
  })

  it("401s with a wrong bearer token", async () => {
    expect((await POST(req("Bearer wrong-token"))).status).toBe(401)
  })
})

import { describe, it, expect, beforeEach } from "vitest"

// Route integration test for POST /api/cron/golazos-sales-history-backfill.
// Fail-closed auth: the handler accepts Bearer INGEST_SECRET_TOKEN / CRON_SECRET
// (or ?token=) and 401s otherwise before any backfill. We pin the guard.

const req = (auth?: string) =>
  ({
    headers: new Headers(auth ? { authorization: auth } : {}),
    nextUrl: new URL("https://t/api/cron/golazos-sales-history-backfill"),
  }) as any

import { POST } from "@/app/api/cron/golazos-sales-history-backfill/route"

beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "test-ingest-secret"
  process.env.CRON_SECRET = "test-cron-secret"
})

describe("POST /api/cron/golazos-sales-history-backfill", () => {
  it("401s with no authorization header", async () => {
    expect((await POST(req())).status).toBe(401)
  })

  it("401s with a wrong bearer token", async () => {
    expect((await POST(req("Bearer wrong-token"))).status).toBe(401)
  })
})

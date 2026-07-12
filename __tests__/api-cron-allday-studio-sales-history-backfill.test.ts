import { describe, it, expect, beforeEach } from "vitest"

// Route integration test for POST /api/cron/allday-studio-sales-history-backfill.
// The POST/GET handlers delegate to lib/studio-sales-history runStudioHistoryDrain,
// whose first step is a fail-closed Bearer check (INGEST_SECRET_TOKEN /
// CRON_SECRET, or ?token=) returning 401 before any drain. We pin that guard.

const req = (auth?: string) =>
  ({
    headers: new Headers(auth ? { authorization: auth } : {}),
    nextUrl: new URL("https://t/api/cron/allday-studio-sales-history-backfill"),
  }) as any

import { POST } from "@/app/api/cron/allday-studio-sales-history-backfill/route"

beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "test-ingest-secret"
  process.env.CRON_SECRET = "test-cron-secret"
})

describe("POST /api/cron/allday-studio-sales-history-backfill", () => {
  it("401s with no authorization header", async () => {
    expect((await POST(req())).status).toBe(401)
  })

  it("401s with a wrong bearer token", async () => {
    expect((await POST(req("Bearer wrong-token"))).status).toBe(401)
  })
})

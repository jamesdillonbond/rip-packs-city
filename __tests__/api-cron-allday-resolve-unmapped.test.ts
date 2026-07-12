import { describe, it, expect, beforeEach } from "vitest"

// Route integration test for POST /api/cron/allday-resolve-unmapped.
// Fail-closed auth: the POST handler checks a Bearer token / ?token= against
// INGEST_SECRET_TOKEN before resolving unmapped AllDay sales and 401s otherwise.
// The token is captured at module load; the guard still 401s any wrong/missing
// credential. We pin that.

const req = (auth?: string) =>
  ({
    headers: new Headers(auth ? { authorization: auth } : {}),
    nextUrl: new URL("https://t/api/cron/allday-resolve-unmapped"),
  }) as any

import { POST } from "@/app/api/cron/allday-resolve-unmapped/route"

beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "test-ingest-secret"
  process.env.CRON_SECRET = "test-cron-secret"
})

describe("POST /api/cron/allday-resolve-unmapped", () => {
  it("401s with no authorization header", async () => {
    expect((await POST(req())).status).toBe(401)
  })

  it("401s with a wrong bearer token", async () => {
    expect((await POST(req("Bearer wrong-token"))).status).toBe(401)
  })
})

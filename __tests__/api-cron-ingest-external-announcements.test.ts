import { describe, it, expect, beforeEach } from "vitest"

// Route integration test for GET /api/cron/ingest-external-announcements.
// Fail-closed auth: the GET handler accepts Bearer INGEST_SECRET_TOKEN /
// CRON_SECRET or ?token=INGEST_SECRET_TOKEN and 401s otherwise before ingesting
// announcements. The token is captured at module load; a missing/wrong
// credential still 401s. We pin that guard.

const req = (auth?: string) =>
  ({
    headers: new Headers(auth ? { authorization: auth } : {}),
    nextUrl: new URL("https://t/api/cron/ingest-external-announcements"),
  }) as any

import { GET } from "@/app/api/cron/ingest-external-announcements/route"

beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "test-ingest-secret"
  process.env.CRON_SECRET = "test-cron-secret"
})

describe("GET /api/cron/ingest-external-announcements", () => {
  it("401s with no authorization header", async () => {
    expect((await GET(req())).status).toBe(401)
  })

  it("401s with a wrong bearer token", async () => {
    expect((await GET(req("Bearer wrong-token"))).status).toBe(401)
  })
})

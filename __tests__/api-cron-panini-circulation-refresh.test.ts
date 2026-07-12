import { describe, it, expect, beforeEach } from "vitest"

// Route integration test for POST /api/cron/panini-circulation-refresh.
// Fail-closed auth: authed() accepts Bearer INGEST_SECRET_TOKEN / CRON_SECRET
// only, 401ing otherwise before any circulation refresh. We pin that guard.

const req = (auth?: string) =>
  ({
    headers: new Headers(auth ? { authorization: auth } : {}),
    nextUrl: new URL("https://t/api/cron/panini-circulation-refresh"),
  }) as any

import { POST } from "@/app/api/cron/panini-circulation-refresh/route"

beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "test-ingest-secret"
  process.env.CRON_SECRET = "test-cron-secret"
})

describe("POST /api/cron/panini-circulation-refresh", () => {
  it("401s with no authorization header", async () => {
    expect((await POST(req())).status).toBe(401)
  })

  it("401s with a wrong bearer token", async () => {
    expect((await POST(req("Bearer wrong-token"))).status).toBe(401)
  })
})

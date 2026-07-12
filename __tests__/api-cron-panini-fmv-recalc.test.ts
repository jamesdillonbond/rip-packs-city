import { describe, it, expect, beforeEach } from "vitest"

// Route integration test for POST /api/cron/panini-fmv-recalc.
// Fail-closed auth: authed() accepts Bearer INGEST_SECRET_TOKEN / CRON_SECRET
// only, 401ing otherwise before any FMV recalc. We pin that guard.

const req = (auth?: string) =>
  ({
    headers: new Headers(auth ? { authorization: auth } : {}),
    nextUrl: new URL("https://t/api/cron/panini-fmv-recalc"),
  }) as any

import { POST } from "@/app/api/cron/panini-fmv-recalc/route"

beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "test-ingest-secret"
  process.env.CRON_SECRET = "test-cron-secret"
})

describe("POST /api/cron/panini-fmv-recalc", () => {
  it("401s with no authorization header", async () => {
    expect((await POST(req())).status).toBe(401)
  })

  it("401s with a wrong bearer token", async () => {
    expect((await POST(req("Bearer wrong-token"))).status).toBe(401)
  })
})

import { describe, it, expect, beforeEach } from "vitest"

// Route integration test for POST /api/cron/alerts-dispatch.
// Fail-closed auth: the handler (run()) checks a Bearer token
// (INGEST_SECRET_TOKEN / CRON_SECRET) before any DB or dispatch work and returns
// 401 on a missing or wrong token. We pin that guard — the highest-value
// behavior for a cron route.

const req = (auth?: string) =>
  ({
    headers: new Headers(auth ? { authorization: auth } : {}),
    nextUrl: new URL("https://t/api/cron/alerts-dispatch"),
  }) as any

import { POST } from "@/app/api/cron/alerts-dispatch/route"

beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "test-ingest-secret"
  process.env.CRON_SECRET = "test-cron-secret"
})

describe("POST /api/cron/alerts-dispatch", () => {
  it("401s with no authorization header", async () => {
    expect((await POST(req())).status).toBe(401)
  })

  it("401s with a wrong bearer token", async () => {
    expect((await POST(req("Bearer wrong-token"))).status).toBe(401)
  })
})

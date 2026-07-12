import { describe, it, expect, beforeEach } from "vitest"

// Route integration test for POST /api/cron/ownership-onchain-walk.
// Fail-closed auth: run() checks a Bearer token (INGEST_SECRET_TOKEN /
// CRON_SECRET) before any Flow REST walk and returns 401 on a missing/wrong
// credential. We pin that guard.

const req = (auth?: string) =>
  ({
    headers: new Headers(auth ? { authorization: auth } : {}),
    nextUrl: new URL("https://t/api/cron/ownership-onchain-walk"),
  }) as any

import { POST } from "@/app/api/cron/ownership-onchain-walk/route"

beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "test-ingest-secret"
  process.env.CRON_SECRET = "test-cron-secret"
})

describe("POST /api/cron/ownership-onchain-walk", () => {
  it("401s with no authorization header", async () => {
    expect((await POST(req())).status).toBe(401)
  })

  it("401s with a wrong bearer token", async () => {
    expect((await POST(req("Bearer wrong-token"))).status).toBe(401)
  })
})

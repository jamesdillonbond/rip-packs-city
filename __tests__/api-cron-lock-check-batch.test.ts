import { describe, it, expect, beforeEach } from "vitest"

// Route integration test for POST /api/cron/lock-check-batch.
// Fail-closed auth: the POST handler compares the Bearer token to a
// module-captured INGEST_SECRET_TOKEN and 401s on a missing/wrong credential
// (also when unset, via `!TOKEN`) before the batch runs in after(). We pin that.

const req = (auth?: string) =>
  ({
    headers: new Headers(auth ? { authorization: auth } : {}),
    nextUrl: new URL("https://t/api/cron/lock-check-batch"),
  }) as any

import { POST } from "@/app/api/cron/lock-check-batch/route"

beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "test-ingest-secret"
  process.env.CRON_SECRET = "test-cron-secret"
})

describe("POST /api/cron/lock-check-batch", () => {
  it("401s with no authorization header", async () => {
    expect((await POST(req())).status).toBe(401)
  })

  it("401s with a wrong bearer token", async () => {
    expect((await POST(req("Bearer wrong-token"))).status).toBe(401)
  })
})

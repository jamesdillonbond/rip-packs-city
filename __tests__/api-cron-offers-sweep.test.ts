import { describe, it, expect, beforeEach } from "vitest"

// Route integration test for POST /api/cron/offers-sweep.
// Fail-closed auth: the POST handler (the sweep runner) requires Bearer /
// `?token=` == INGEST_SECRET_TOKEN and 401s otherwise before walking the Top
// Shot marketplace. (GET is a deliberately public status endpoint — not tested
// here.) We pin the POST guard.

const req = (auth?: string) =>
  ({
    headers: new Headers(auth ? { authorization: auth } : {}),
    nextUrl: new URL("https://t/api/cron/offers-sweep"),
  }) as any

import { POST } from "@/app/api/cron/offers-sweep/route"

beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "test-ingest-secret"
  process.env.CRON_SECRET = "test-cron-secret"
})

describe("POST /api/cron/offers-sweep", () => {
  it("401s with no authorization header", async () => {
    expect((await POST(req())).status).toBe(401)
  })

  it("401s with a wrong bearer token", async () => {
    expect((await POST(req("Bearer wrong-token"))).status).toBe(401)
  })
})

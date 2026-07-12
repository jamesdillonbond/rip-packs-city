import { describe, it, expect, beforeEach } from "vitest"

// Route integration test for POST /api/cron/pinnacle-listings-reconcile.
// Two-stage fail-closed guard (read at call time): 500 if INGEST_SECRET_TOKEN is
// unset, else 401 on a missing/wrong Bearer or ?token= before any reconcile. We
// pin both.

const req = (auth?: string) =>
  ({
    headers: new Headers(auth ? { authorization: auth } : {}),
    nextUrl: new URL("https://t/api/cron/pinnacle-listings-reconcile"),
  }) as any

import { POST } from "@/app/api/cron/pinnacle-listings-reconcile/route"

beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "test-ingest-secret"
})

describe("POST /api/cron/pinnacle-listings-reconcile", () => {
  it("500s when INGEST_SECRET_TOKEN is unset", async () => {
    delete process.env.INGEST_SECRET_TOKEN
    expect((await POST(req("Bearer whatever"))).status).toBe(500)
  })

  it("401s with a wrong bearer token", async () => {
    expect((await POST(req("Bearer wrong-token"))).status).toBe(401)
  })

  it("401s with no authorization header", async () => {
    expect((await POST(req())).status).toBe(401)
  })
})

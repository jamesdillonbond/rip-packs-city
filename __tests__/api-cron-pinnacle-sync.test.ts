import { describe, it, expect, beforeEach } from "vitest"

// Route integration test for GET /api/cron/pinnacle-sync.
// Fail-closed auth: the GET handler requires Bearer INGEST_SECRET_TOKEN exactly
// and 401s otherwise before rebuilding the per-render Pinnacle FMV home. We pin
// that guard.

const req = (auth?: string) =>
  ({
    headers: new Headers(auth ? { authorization: auth } : {}),
    nextUrl: new URL("https://t/api/cron/pinnacle-sync"),
  }) as any

import { GET } from "@/app/api/cron/pinnacle-sync/route"

beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "test-ingest-secret"
})

describe("GET /api/cron/pinnacle-sync", () => {
  it("401s with no authorization header", async () => {
    expect((await GET(req())).status).toBe(401)
  })

  it("401s with a wrong bearer token", async () => {
    expect((await GET(req("Bearer wrong-token"))).status).toBe(401)
  })
})

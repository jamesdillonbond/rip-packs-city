import { describe, it, expect, beforeEach } from "vitest"

// Route integration test for GET /api/cron/pinnacle-metadata-backfill.
// Fail-closed auth: the GET handler checks a Bearer token / ?token= against a
// module-captured INGEST_SECRET_TOKEN and 401s on a missing/wrong credential
// (also when unset, via `!TOKEN`) before any metadata backfill. We pin that.

const req = (auth?: string) =>
  ({
    headers: new Headers(auth ? { authorization: auth } : {}),
    nextUrl: new URL("https://t/api/cron/pinnacle-metadata-backfill"),
  }) as any

import { GET } from "@/app/api/cron/pinnacle-metadata-backfill/route"

beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "test-ingest-secret"
})

describe("GET /api/cron/pinnacle-metadata-backfill", () => {
  it("401s with no authorization header", async () => {
    expect((await GET(req())).status).toBe(401)
  })

  it("401s with a wrong bearer token", async () => {
    expect((await GET(req("Bearer wrong-token"))).status).toBe(401)
  })
})

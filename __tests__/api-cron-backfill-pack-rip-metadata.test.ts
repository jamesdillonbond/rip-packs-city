import { describe, it, expect, beforeEach } from "vitest"

// Route integration test for POST /api/cron/backfill-pack-rip-metadata.
// Fail-closed auth: the handler requires Bearer INGEST_SECRET_TOKEN exactly and
// 401s otherwise before running backfill_pack_rip_metadata. We pin the guard.

const req = (auth?: string) =>
  ({
    headers: new Headers(auth ? { authorization: auth } : {}),
    nextUrl: new URL("https://t/api/cron/backfill-pack-rip-metadata"),
  }) as any

import { POST } from "@/app/api/cron/backfill-pack-rip-metadata/route"

beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "test-ingest-secret"
  process.env.CRON_SECRET = "test-cron-secret"
})

describe("POST /api/cron/backfill-pack-rip-metadata", () => {
  it("401s with no authorization header", async () => {
    expect((await POST(req())).status).toBe(401)
  })

  it("401s with a wrong bearer token", async () => {
    expect((await POST(req("Bearer wrong-token"))).status).toBe(401)
  })
})

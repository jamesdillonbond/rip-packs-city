import { describe, it, expect, beforeEach } from "vitest"

// Route integration test for POST /api/cron/drain-base-parallel-probe.
// Fail-closed auth: authed() accepts verifyAdminRequest (RPC_ADMIN_TOKEN) or a
// Bearer/`?token=` matching CRON_SECRET / INGEST_SECRET_TOKEN / RPC_ADMIN_TOKEN;
// otherwise adminUnauthorizedResponse() → 401, before any edge-fn trigger. We
// pin that guard.

const req = (auth?: string) =>
  ({
    headers: new Headers(auth ? { authorization: auth } : {}),
    nextUrl: new URL("https://t/api/cron/drain-base-parallel-probe"),
  }) as any

import { POST } from "@/app/api/cron/drain-base-parallel-probe/route"

beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "test-ingest-secret"
  process.env.CRON_SECRET = "test-cron-secret"
  process.env.RPC_ADMIN_TOKEN = "test-admin-secret"
})

describe("POST /api/cron/drain-base-parallel-probe", () => {
  it("401s with no authorization header", async () => {
    expect((await POST(req())).status).toBe(401)
  })

  it("401s with a wrong bearer token", async () => {
    expect((await POST(req("Bearer wrong-token"))).status).toBe(401)
  })
})

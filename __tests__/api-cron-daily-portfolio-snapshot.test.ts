import { describe, it, expect, beforeEach } from "vitest"

// Route integration test for GET /api/cron/daily-portfolio-snapshot.
// Fail-closed auth: the GET handler accepts Bearer INGEST_SECRET_TOKEN /
// CRON_SECRET or ?token=, returning 401 ({ error: "unauthorized" }) otherwise
// before snapshotting portfolios. We pin that guard.

const req = (auth?: string) =>
  ({
    headers: new Headers(auth ? { authorization: auth } : {}),
    nextUrl: new URL("https://t/api/cron/daily-portfolio-snapshot"),
  }) as any

import { GET } from "@/app/api/cron/daily-portfolio-snapshot/route"

beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "test-ingest-secret"
  process.env.CRON_SECRET = "test-cron-secret"
})

describe("GET /api/cron/daily-portfolio-snapshot", () => {
  it("401s with no authorization header", async () => {
    const res = await GET(req())
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe("unauthorized")
  })

  it("401s with a wrong bearer token", async () => {
    expect((await GET(req("Bearer wrong-token"))).status).toBe(401)
  })
})

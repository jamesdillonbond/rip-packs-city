import { describe, it, expect } from "vitest"

// Route integration test for GET /api/ufc-pipeline. A cron trigger that chains
// ufc-listing-cache → ufc-sales-indexer. Bearer INGEST_SECRET_TOKEN (or ?token=)
// gated → fail-closed 401 (TOKEN captured at module load from an unset env).
// The chained fetches run in after() and are out of scope. No DB import.

import { GET } from "@/app/api/ufc-pipeline/route"

const req = (u: string, headers: Record<string, string> = {}) =>
  ({ nextUrl: new URL(u), url: u, headers: new Headers(headers) }) as any

describe("GET /api/ufc-pipeline — fail-closed auth", () => {
  it("401s without a token", async () => {
    expect((await GET(req("https://t/api/ufc-pipeline"))).status).toBe(401)
  })
  it("401s with a bogus token (expected TOKEN unset in-test)", async () => {
    expect((await GET(req("https://t/api/ufc-pipeline?token=x"))).status).toBe(401)
  })
})

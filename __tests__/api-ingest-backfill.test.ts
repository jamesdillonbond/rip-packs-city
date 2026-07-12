import { describe, it, expect, beforeEach, vi } from "vitest"
import { makeReq } from "./cron-req-helper"

// Route integration test for /api/ingest/backfill (GET + POST → handleBackfill).
// Auth is Bearer INGEST_SECRET_TOKEN but ONLY enforced when that env var is set
// (`if (expectedToken && authHeader !== ...)`) — so we pin: 401 when the secret
// is set + the header is wrong, the year-param 400 guard, and a mocked empty
// happy path (topshotGraphql returns no transactions → rows_inserted 0).

const state = { gql: {} as any }

vi.mock("@/lib/topshot", () => ({
  topshotGraphql: async () => state.gql,
}))
vi.mock("@/lib/supabase", () => {
  const b: any = {
    from: () => b,
    select: () => b,
    in: async () => ({ data: [] }),
    insert: () => b,
  }
  return { supabaseAdmin: b, supabase: b }
})

import { GET, POST } from "@/app/api/ingest/backfill/route"

beforeEach(() => {
  state.gql = {}
  vi.unstubAllEnvs()
})

describe("/api/ingest/backfill", () => {
  it("401s when INGEST_SECRET_TOKEN is set and the Bearer header is wrong", async () => {
    vi.stubEnv("INGEST_SECRET_TOKEN", "secret")
    const res = await GET(
      makeReq({ url: "https://t/api/ingest/backfill", method: "GET", auth: "Bearer wrong" })
    )
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe("Unauthorized")
  })

  it("400s on an out-of-range year", async () => {
    // No INGEST_SECRET_TOKEN env → auth is bypassed, so we reach the year guard.
    const res = await GET(
      makeReq({ url: "https://t/api/ingest/backfill?year=2020", method: "GET" })
    )
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain("Invalid year")
  })

  it("returns ok with 0 rows when the GQL page has no transactions", async () => {
    state.gql = {} // parseTxs → []
    const res = await POST(
      makeReq({ url: "https://t/api/ingest/backfill?year=2025", method: "POST", body: {} })
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.rows_inserted).toBe(0)
    expect(body.hasMore).toBe(false)
  })
})

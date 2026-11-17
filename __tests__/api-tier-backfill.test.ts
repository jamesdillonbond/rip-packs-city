import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

// Route integration test for GET /api/tier-backfill. A wallet_moments_cache tier
// backfill sweep gated by ?token= against INGEST_SECRET_TOKEN → fail-closed 401
// when the token is missing/mismatched. Success path: a matching token with an
// empty candidate set (no null-tier rows) short-circuits to the "backfill
// complete" 200 before any GQL work. createClient is a self-referential
// chainable resolving the empty first-page read.

const state: { rows: any; rangeArgs: number[] } = { rows: { data: [], error: null }, rangeArgs: [] }

vi.mock("@supabase/supabase-js", () => {
  const b: any = {
    select: () => b, eq: () => b, is: () => b, order: () => b,
    range: (a: number, c: number) => { state.rangeArgs = [a, c]; return b },
    then: (resolve: any) => resolve(state.rows),
  }
  return { createClient: () => ({ from: () => b }) }
})

import { GET } from "@/app/api/tier-backfill/route"

const req = (u: string) => ({ nextUrl: new URL(u) }) as any
const saved = process.env.INGEST_SECRET_TOKEN
const TOKEN = "tier-backfill-token"

beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = TOKEN
  state.rows = { data: [], error: null }
  state.rangeArgs = []
})
afterEach(() => {
  if (saved === undefined) delete process.env.INGEST_SECRET_TOKEN
  else process.env.INGEST_SECRET_TOKEN = saved
})

describe("GET /api/tier-backfill", () => {
  it("401s without a matching token (fail-closed)", async () => {
    expect((await GET(req("https://t/api/tier-backfill"))).status).toBe(401)
    expect((await GET(req("https://t/api/tier-backfill?token=wrong"))).status).toBe(401)
  })

  it("200s and reports backfill-complete when no null-tier rows remain", async () => {
    state.rows = { data: [], error: null }
    const res = await GET(req(`https://t/api/tier-backfill?token=${TOKEN}`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.message).toContain("backfill complete")
    expect(body.total).toBe(0)
  })

  it("defaults a NaN limit/offset to finite .range() bounds (never .range(0, NaN))", async () => {
    const res = await GET(req(`https://t/api/tier-backfill?token=${TOKEN}&limit=abc&offset=xyz`))
    expect(res.status).toBe(200)
    expect(state.rangeArgs).toHaveLength(2)
    expect(Number.isFinite(state.rangeArgs[0])).toBe(true)
    expect(Number.isFinite(state.rangeArgs[1])).toBe(true)
    expect(state.rangeArgs[0]).toBe(0)                 // bad offset -> 0
    expect(state.rangeArgs[1]).toBeGreaterThanOrEqual(0) // bad limit -> BATCH_SIZE, upper bound finite
  })
})

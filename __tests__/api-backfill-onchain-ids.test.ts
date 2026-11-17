import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

// Route integration test for GET /api/backfill-onchain-ids.
// Auth is a ?secret= query param compared to INGEST_SECRET_TOKEN at call time
// (`searchParams.get("secret") !== process.env.INGEST_SECRET_TOKEN` → 401),
// checked before any DB read or TopShot GQL resolution. We pin the fail-closed
// guard (the happy path walks editions + queries the TS proxy — network).

const state: { rangeArgs: number[] } = { rangeArgs: [] }

vi.mock("@supabase/supabase-js", () => {
  const b: any = {
    select: () => b, is: () => b, order: () => b,
    range: (a: number, c: number) => {
      state.rangeArgs = [a, c]
      return Promise.resolve({ data: [], error: null }) // empty -> route short-circuits before network
    },
  }
  return { createClient: () => ({ from: () => b }) }
})

import { GET } from "@/app/api/backfill-onchain-ids/route"

const TOKEN = "test-ingest-token"

function req(secret?: string): Request {
  const url = "https://t/api/backfill-onchain-ids" + (secret ? `?secret=${secret}` : "")
  return new Request(url)
}

beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = TOKEN
  state.rangeArgs = []
})
afterEach(() => {
  process.env.INGEST_SECRET_TOKEN = TOKEN
})

describe("GET /api/backfill-onchain-ids", () => {
  it("401s without the secret query param", async () => {
    expect((await GET(req())).status).toBe(401)
  })

  it("401s with a wrong secret", async () => {
    expect((await GET(req("wrong"))).status).toBe(401)
  })

  it("defaults a NaN limit/offset to finite .range() bounds (never .range(0, NaN))", async () => {
    const url = `https://t/api/backfill-onchain-ids?secret=${TOKEN}&limit=abc&offset=xyz`
    const res = await GET(new Request(url))
    expect(res.status).toBe(200)
    expect(state.rangeArgs).toHaveLength(2)
    expect(Number.isFinite(state.rangeArgs[0])).toBe(true)
    expect(Number.isFinite(state.rangeArgs[1])).toBe(true)
    expect(state.rangeArgs[0]).toBe(0)     // bad offset -> 0
    expect(state.rangeArgs[1]).toBe(99)    // bad limit -> 100 default, upper bound 0 + 100 - 1
  })
})

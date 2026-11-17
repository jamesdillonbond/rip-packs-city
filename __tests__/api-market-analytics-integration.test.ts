import { describe, it, expect, vi } from "vitest"
import { NextRequest } from "next/server"
import { makeSupabaseFixture } from "./helpers/route-harness"

// Route-integration test for GET /api/market-analytics. This route fans out to
// many SQL-aggregated RPCs; makeSupabaseFixture returns an empty result for
// every unmocked rpc/table, so a single all-empty fixture drives the WHOLE GET
// orchestration end-to-end (collection dispatch, period math, response assembly)
// and asserts it returns a stable 200 shape rather than throwing — while the
// unknown-collection guard is exercised directly.

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: makeSupabaseFixture({}) }))

const { GET } = await import("@/app/api/market-analytics/route")

function get(qs: string) {
  return new NextRequest(`https://t/api/market-analytics${qs}`)
}

describe("GET /api/market-analytics — integration", () => {
  it("400s on an unknown collection slug", async () => {
    const res = await GET(get("?collection=not-a-collection"))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("Unknown collection")
  })

  it("returns 200 with a stable shape for Top Shot when all RPCs are empty", async () => {
    const res = await GET(get("?collection=nba-top-shot&period=30d"))
    expect(res.status).toBe(200)
    const body = await res.json()
    // The handler ran to completion (didn't throw into the 500 catch) and
    // produced an object response, not an { error } payload.
    expect(body).toBeTypeOf("object")
    expect(body.error).toBeUndefined()
  })

  it("dispatches the Pinnacle collection through its own RPC variants (200)", async () => {
    const res = await GET(get("?collection=disney-pinnacle&period=7d"))
    expect(res.status).toBe(200)
    expect((await res.json()).error).toBeUndefined()
  })

  it("accepts the ytd period without error", async () => {
    const res = await GET(get("?collection=nba-top-shot&period=ytd"))
    expect(res.status).toBe(200)
  })
})

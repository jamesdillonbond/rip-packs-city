import { describe, it, expect, vi } from "vitest"
import { NextRequest } from "next/server"
import { makeSupabaseFixture } from "./helpers/route-harness"

// Route-integration test for GET /api/market. The listing feed pulls from an
// RPC and (for Top Shot) an FMV display guard; makeSupabaseFixture's empty
// default returns [] for every RPC/query so an all-empty setup drives the full
// GET body — filter parsing, RPC dispatch, tier-ceiling clamp, pagination
// assembly — to a stable 200 empty feed, plus the required-param guard.

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: makeSupabaseFixture({}) }))

const { GET } = await import("@/app/api/market/route")

const TS = "95f28a17-224a-4025-96ad-adf8a4c63bfd"
const ALLDAY = "dee28451-5d62-409e-a1ad-a83f763ac070"
const get = (qs: string) => new NextRequest(`https://t/api/market${qs}`)

describe("GET /api/market — integration", () => {
  it("400s when collectionId is missing", async () => {
    const res = await GET(get(""))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("collectionId is required")
  })

  it("returns a stable 200 empty feed for a non-Top-Shot collection (all RPCs empty)", async () => {
    const res = await GET(get(`?collectionId=${ALLDAY}`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.error).toBeUndefined()
    expect(Array.isArray(body.listings)).toBe(true)
    expect(body.listings).toHaveLength(0)
  })

  it("drives the Top Shot path (FMV display guard) to a stable 200", async () => {
    const res = await GET(get(`?collectionId=${TS}&page=1`))
    expect(res.status).toBe(200)
    expect((await res.json()).error).toBeUndefined()
  })

  it("parses filter params without error (tier/price/player)", async () => {
    const res = await GET(get(`?collectionId=${ALLDAY}&tier=COMMON,RARE&minPrice=1&maxPrice=100&player=Curry`))
    expect(res.status).toBe(200)
  })
})

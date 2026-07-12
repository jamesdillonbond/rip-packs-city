import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for /api/market (GET).
// Guard: collectionId (or collection_id) is required else 400. For a non-TS /
// non-AllDay collection, fetchModernListings returns null and the handler falls
// through to the legacy cached_listings query. We mock @/lib/supabase as a
// chainable+thenable builder resolving empty, giving a clean 200 empty happy
// path. (TS's FMV display-guard path is not exercised here — non-TS skips it.)

vi.mock("@/lib/supabase", () => {
  const result: any = { data: [], error: null, count: 0 }
  const b: any = {
    from: () => b, select: () => b, eq: () => b, not: () => b, lte: () => b,
    gte: () => b, in: () => b, ilike: () => b, overlaps: () => b, order: () => b,
    range: () => b, limit: () => b, filter: () => b, or: () => b, single: () => b,
    then: (res: any) => res(result),
    rpc: async () => ({ data: null, error: null }),
  }
  return { supabaseAdmin: b, supabase: b }
})

import { GET } from "@/app/api/market/route"

const req = (u: string) => ({ nextUrl: new URL(u) }) as any

const GOLAZOS = "06248cc4-b85f-47cd-af67-1855d14acd75"

describe("GET /api/market", () => {
  it("400s when collectionId is missing", async () => {
    const res = await GET(req("https://t/api/market"))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("collectionId is required")
  })

  it("returns an empty, paginated payload for a collection with no listings", async () => {
    const res = await GET(req(`https://t/api/market?collectionId=${GOLAZOS}`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.listings).toEqual([])
    expect(body.pagination).toMatchObject({ total: 0, page: 1, hasMore: false })
    expect(body.clamp.applied).toBe(true)
  })
})

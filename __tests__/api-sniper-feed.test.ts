import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for GET /api/sniper-feed.
// Public GET, no auth. The feed body is a heavy Top Shot GQL + Supabase merge,
// but there IS a simple seam: getOrSetCache(key, ttl, factory) wraps the compute
// fn, and for the non-Top-Shot/AllDay/Pinnacle collections (golazos/ufc) the
// factory short-circuits to an EMPTY deals[] with NO DB call. We mock @/lib/cache
// to invoke the factory synchronously, exercise the empty golazos path (happy),
// and force the factory to throw to pin the 500 "Feed unavailable" catch.

const cache: { throw: boolean } = { throw: false }

vi.mock("@/lib/cache", () => ({
  getOrSetCache: async (_k: string, _ttl: number, factory: () => Promise<any>) => {
    if (cache.throw) throw new Error("boom")
    return factory()
  },
}))

import { GET } from "@/app/api/sniper-feed/route"

const req = (url: string) => new Request(url)

beforeEach(() => {
  cache.throw = false
})

describe("GET /api/sniper-feed", () => {
  it("returns an empty feed for a collection with no live source (golazos)", async () => {
    const res = await GET(req("https://t/api/sniper-feed?collection=laliga-golazos"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.count).toBe(0)
    expect(body.deals).toEqual([])
    expect(body.marketplaceAvailability).toEqual({ topshot: true, flowty: false })
  })

  it("500s 'Feed unavailable' when the compute throws", async () => {
    cache.throw = true
    const res = await GET(req("https://t/api/sniper-feed?collection=laliga-golazos"))
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).toBe("Feed unavailable")
    expect(body.deals).toEqual([])
  })
})

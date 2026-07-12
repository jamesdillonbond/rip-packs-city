import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for GET /api/pack-listings.
// Thin wrapper over lib/packs/live-pack-listings (Dapper Studio fetch + cache).
// Pins the unsupported-collection 400 guard and the cached/uncached happy
// shapes via a mocked fetchLivePackListings seam.

const state: { listings: any[]; cached: boolean; throwErr: Error | null } = {
  listings: [],
  cached: false,
  throwErr: null,
}

vi.mock("@/lib/packs/live-pack-listings", () => ({
  SUPPORTED_PACK_COLLECTIONS: ["nba-top-shot", "nfl-all-day"],
  isSupportedPackCollection: (slug: string) =>
    slug === "nba-top-shot" || slug === "nfl-all-day",
  fetchLivePackListings: async () => {
    if (state.throwErr) throw state.throwErr
    return { listings: state.listings, cached: state.cached }
  },
}))

import { GET } from "@/app/api/pack-listings/route"

const req = (url: string) => ({ url }) as any

beforeEach(() => {
  state.listings = []
  state.cached = false
  state.throwErr = null
})

describe("GET /api/pack-listings", () => {
  it("400s on an unsupported collection", async () => {
    const res = await GET(req("https://t/api/pack-listings?collection=disney-pinnacle"))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain("Unsupported collection")
  })

  it("returns fresh listings with totalPacks when not cached", async () => {
    state.listings = [{ distId: "1", lowestAsk: 10, listingCount: 2 }]
    state.cached = false
    const res = await GET(req("https://t/api/pack-listings"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.cached).toBe(false)
    expect(body.totalPacks).toBe(1)
    expect(body.collection).toBe("nba-top-shot")
  })

  it("returns cached listings without totalPacks when cached", async () => {
    state.listings = [{ distId: "1", lowestAsk: 10, listingCount: 2 }]
    state.cached = true
    const res = await GET(req("https://t/api/pack-listings?collection=nfl-all-day"))
    const body = await res.json()
    expect(body.cached).toBe(true)
    expect(body.totalPacks).toBeUndefined()
  })

  it("500s when the fetch helper throws", async () => {
    state.throwErr = new Error("dapper down")
    const res = await GET(req("https://t/api/pack-listings"))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("dapper down")
  })
})

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

// Unit tests for lib/packs/live-pack-listings.ts (was ~7%). The pure helpers
// (isSupportedPackCollection / SUPPORTED_PACK_COLLECTIONS) are pinned exactly,
// and fetchLivePackListings is driven with a stubbed global fetch returning
// hand-built searchPackNftAggregation payloads: node→PackListing mapping,
// per-dist aggregation (count + lowest ask), packType classification, series
// labels, sort order, the 2-minute cache, and the empty / GraphQL-error /
// throw branches. Every fetch-driving case passes { force: true } so the
// module-level cache from a sibling test can't short-circuit the fetch.

import {
  fetchLivePackListings,
  isSupportedPackCollection,
  SUPPORTED_PACK_COLLECTIONS,
} from "@/lib/packs/live-pack-listings"

// ── payload builders ──────────────────────────────────────────────────────────
function node(over: {
  distId: string
  min?: string
  uuid?: string | null
  title?: string | null
  tier?: string | null
  slots?: string | null
  price?: number | null
  startTime?: string | null
  image?: string[] | null
}) {
  return {
    dist_id: { key: "dist", value: over.distId },
    listing: { price: { min: over.min ?? "0" } },
    distribution: {
      id: { value: over.distId },
      uuid: { value: over.uuid === undefined ? `uuid-${over.distId}` : over.uuid },
      image_urls: { value: over.image === undefined ? ["http://img/a.png"] : over.image },
      number_of_pack_slots: { value: over.slots === undefined ? "5" : over.slots },
      pack_type: { value: "standard" },
      price: { value: over.price === undefined ? 9 : over.price },
      start_time: { value: over.startTime === undefined ? "2024-09-08T00:00:00Z" : over.startTime },
      tier: { value: over.tier === undefined ? "common" : over.tier },
      title: { value: over.title === undefined ? "Base Set Pack" : over.title },
    },
  }
}

function gqlOk(nodes: any[], over: Partial<{ hasNextPage: boolean; endCursor: string | null }> = {}) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      data: {
        searchPackNftAggregation: {
          pageInfo: { endCursor: over.endCursor ?? null, hasNextPage: over.hasNextPage ?? false },
          totalCount: nodes.length,
          edges: nodes.map((n) => ({ node: n })),
        },
      },
    }),
  }
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn())
})
afterEach(() => vi.unstubAllGlobals())

// ── pure helpers ──────────────────────────────────────────────────────────────
describe("isSupportedPackCollection / SUPPORTED_PACK_COLLECTIONS", () => {
  it("recognizes exactly the two configured slugs", () => {
    expect(SUPPORTED_PACK_COLLECTIONS).toEqual(["nba-top-shot", "nfl-all-day"])
    expect(isSupportedPackCollection("nba-top-shot")).toBe(true)
    expect(isSupportedPackCollection("nfl-all-day")).toBe(true)
  })
  it("rejects any unknown slug", () => {
    expect(isSupportedPackCollection("disney-pinnacle")).toBe(false)
    expect(isSupportedPackCollection("")).toBe(false)
    expect(isSupportedPackCollection("topshot")).toBe(false)
  })
})

// ── node → PackListing mapping ────────────────────────────────────────────────
describe("fetchLivePackListings — mapping", () => {
  it("maps a node to a PackListing (ask ÷ 1e8, slots, series label, image, ids)", async () => {
    ;(fetch as any).mockResolvedValue(
      gqlOk([node({ distId: "d1", min: "5000000000", startTime: "2024-09-08T00:00:00Z" })]),
    )
    const { listings, cached } = await fetchLivePackListings("nba-top-shot", { force: true })
    expect(cached).toBe(false)
    expect(listings).toHaveLength(1)
    const l = listings[0]
    expect(l.distId).toBe("d1")
    expect(l.lowestAsk).toBe(50) // 5000000000 / 1e8
    expect(l.momentsPerPack).toBe(5)
    expect(l.retailPrice).toBe(9)
    expect(l.tier).toBe("common")
    expect(l.imageUrl).toBe("http://img/a.png")
    expect(l.packListingId).toBe("uuid-d1")
    expect(l.seriesLabel).toBe("Series 2024-25")
    expect(l.listingCount).toBe(1)
    expect(l.packType).toBe("standard")
  })

  it("falls back on null distribution scalars (uuid→distId, title→Pack #, tier→common, image→'')", async () => {
    ;(fetch as any).mockResolvedValue(
      gqlOk([node({ distId: "d2", uuid: null, title: null, tier: null, image: null, slots: null, price: null, startTime: null })]),
    )
    const { listings } = await fetchLivePackListings("nfl-all-day", { force: true })
    const l = listings[0]
    expect(l.packListingId).toBe("d2")
    expect(l.title).toBe("Pack #d2")
    expect(l.tier).toBe("common")
    expect(l.imageUrl).toBe("")
    expect(l.momentsPerPack).toBe(1) // null slots → default 1
    expect(l.seriesLabel).toBe("Unknown") // empty start time
  })

  it("skips nodes with no dist_id value and aggregates duplicates onto one dist (count + lowest ask)", async () => {
    ;(fetch as any).mockResolvedValue(
      gqlOk([
        node({ distId: "dup", min: "9000000000" }), // 90
        node({ distId: "dup", min: "3000000000" }), // 30 → wins lowest
        { dist_id: { key: "d", value: null }, listing: { price: { min: "0" } }, distribution: null },
      ]),
    )
    const { listings } = await fetchLivePackListings("nba-top-shot", { force: true })
    expect(listings).toHaveLength(1)
    expect(listings[0].listingCount).toBe(2)
    expect(listings[0].lowestAsk).toBe(30)
  })
})

// ── packType classification ───────────────────────────────────────────────────
describe("fetchLivePackListings — packType", () => {
  async function classify(over: Parameters<typeof node>[0]) {
    ;(fetch as any).mockResolvedValue(gqlOk([node(over)]))
    const { listings } = await fetchLivePackListings("nba-top-shot", { force: true })
    return listings[0].packType
  }

  it("classifies bundle / topper / chance_hit / reward / standard", async () => {
    expect(await classify({ distId: "b", slots: "12" })).toBe("bundle")
    expect(await classify({ distId: "t", slots: "5", title: "Series Topper Pack" })).toBe("topper")
    expect(await classify({ distId: "c", slots: "5", title: "Chance Hit Drop" })).toBe("chance_hit")
    expect(await classify({ distId: "r1", slots: "1", price: 0 })).toBe("reward") // free single = reward
    expect(await classify({ distId: "s1", slots: "1", price: 5, title: "Solo Pack" })).toBe("chance_hit") // paid single
    expect(await classify({ distId: "r2", slots: "3", price: 0 })).toBe("reward") // free small
    expect(await classify({ distId: "fb", slots: "2", price: 5, title: "Fast Break Reward" })).toBe("reward")
    expect(await classify({ distId: "prem", slots: "3", price: 5, title: "Premium Chase" })).toBe("chance_hit")
    expect(await classify({ distId: "std", slots: "5", price: 9, title: "Base Set Pack" })).toBe("standard")
  })
})

// ── series label boundaries ───────────────────────────────────────────────────
describe("fetchLivePackListings — seriesLabel", () => {
  async function label(startTime: string) {
    ;(fetch as any).mockResolvedValue(gqlOk([node({ distId: "x", startTime })]))
    const { listings } = await fetchLivePackListings("nba-top-shot", { force: true })
    return listings[0].seriesLabel
  }

  it("maps start-time windows to the right series", async () => {
    expect(await label("2020-05-01T00:00:00Z")).toBe("Series 1")
    expect(await label("2021-08-01T00:00:00Z")).toBe("Series 2")
    expect(await label("2022-08-01T00:00:00Z")).toBe("Series 3")
    expect(await label("2023-08-01T00:00:00Z")).toBe("Series 2023-24")
    expect(await label("2024-08-01T00:00:00Z")).toBe("Series 2024-25")
    expect(await label("2025-09-01T00:00:00Z")).toBe("Series 2025-26")
    expect(await label("not-a-date")).toBe("Unknown")
  })
})

// ── sort order ────────────────────────────────────────────────────────────────
describe("fetchLivePackListings — sort", () => {
  it("orders bundles last, then by tier, then by lowest ask", async () => {
    ;(fetch as any).mockResolvedValue(
      gqlOk([
        node({ distId: "bundle", slots: "12", tier: "legendary", min: "100000000" }),
        node({ distId: "rare", tier: "rare", min: "800000000" }),
        node({ distId: "leg-hi", tier: "legendary", min: "900000000" }),
        node({ distId: "leg-lo", tier: "legendary", min: "500000000" }),
      ]),
    )
    const { listings } = await fetchLivePackListings("nba-top-shot", { force: true })
    expect(listings.map((l) => l.distId)).toEqual(["leg-lo", "leg-hi", "rare", "bundle"])
  })
})

// ── cache + error branches ────────────────────────────────────────────────────
describe("fetchLivePackListings — cache and errors", () => {
  it("serves the second call from cache without re-fetching", async () => {
    const f = vi.fn().mockResolvedValue(gqlOk([node({ distId: "cached-d" })]))
    vi.stubGlobal("fetch", f)
    const first = await fetchLivePackListings("nba-top-shot", { force: true }) // populates cache
    expect(first.cached).toBe(false)
    const second = await fetchLivePackListings("nba-top-shot") // no force → cache hit
    expect(second.cached).toBe(true)
    expect(second.listings).toBe(first.listings)
    expect(f).toHaveBeenCalledTimes(1)
  })

  it("returns an empty list when the response has no connection object", async () => {
    ;(fetch as any).mockResolvedValue({ ok: true, status: 200, json: async () => ({ data: {} }) })
    const { listings } = await fetchLivePackListings("nfl-all-day", { force: true })
    expect(listings).toEqual([])
  })

  it("throws the first GraphQL error message", async () => {
    ;(fetch as any).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ errors: [{ message: "rate limited" }] }),
    })
    await expect(fetchLivePackListings("nba-top-shot", { force: true })).rejects.toThrow("rate limited")
  })

  it("propagates a fetch transport error", async () => {
    ;(fetch as any).mockRejectedValue(new Error("ECONNRESET"))
    await expect(fetchLivePackListings("nba-top-shot", { force: true })).rejects.toThrow("ECONNRESET")
  })

  it("walks pagination until hasNextPage is false", async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(gqlOk([node({ distId: "p1" })], { hasNextPage: true, endCursor: "c1" }))
      .mockResolvedValueOnce(gqlOk([node({ distId: "p2" })], { hasNextPage: false }))
    vi.stubGlobal("fetch", f)
    const { listings } = await fetchLivePackListings("nfl-all-day", { force: true })
    expect(f).toHaveBeenCalledTimes(2)
    expect(listings.map((l) => l.distId).sort()).toEqual(["p1", "p2"])
  })
})

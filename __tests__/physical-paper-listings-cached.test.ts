import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

// The cached entry point: off outside the cache, never caches a failure,
// counts only cache misses against the site-wide cap.

describe("getPaperListings", () => {
  const saved = { ...process.env }
  beforeEach(() => {
    vi.resetModules()
    // Pass-through cache: each call is a miss, which is the path under test.
    vi.doMock("next/cache", () => ({ unstable_cache: (fn: (...a: unknown[]) => unknown) => fn }))
  })
  afterEach(() => {
    process.env = { ...saved }
    vi.restoreAllMocks()
  })

  it("returns off without touching the cache, the counter or eBay", async () => {
    delete process.env.PHYSICAL_EBAY_LISTINGS
    const bump = vi.fn()
    vi.doMock("@/lib/abuse/anon-rate", () => ({ bumpAnonRates: bump }))
    const fetchSpy = vi.spyOn(globalThis, "fetch")
    const { getPaperListings } = await import("@/lib/physical/ebay-listings-cached")
    expect(await getPaperListings("Cooper Flagg", "cooper-flagg")).toEqual({ status: "off" })
    expect(bump).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("turns a refused counter into an uncached error with no eBay call", async () => {
    process.env.PHYSICAL_EBAY_LISTINGS = "1"
    process.env.EBAY_CLIENT_ID = "id"
    process.env.EBAY_CLIENT_SECRET = "s"
    const bump = vi.fn(async (_caps: { bucket: string; key: string; limit: number; windowSecs: number }[]) => ({ allowed: false, failed: true, count: null, refusedBucket: "ebay_browse_global" }))
    vi.doMock("@/lib/abuse/anon-rate", () => ({ bumpAnonRates: bump }))
    const fetchSpy = vi.spyOn(globalThis, "fetch")
    const { getPaperListings } = await import("@/lib/physical/ebay-listings-cached")
    expect(await getPaperListings("Cooper Flagg", "cooper-flagg")).toEqual({ status: "error" })
    expect(bump).toHaveBeenCalledTimes(1)
    expect(bump.mock.calls[0][0][0]).toMatchObject({ bucket: "ebay_browse_global", key: "*", limit: 4000, windowSecs: 86400 })
    expect(fetchSpy).not.toHaveBeenCalled()
  })
  it("never serves a cached result older than 6 h, nor one with no stamp", async () => {
    process.env.PHYSICAL_EBAY_LISTINGS = "1"
    process.env.EBAY_CLIENT_ID = "id"
    process.env.EBAY_CLIENT_SECRET = "s"
    const at = Date.parse("2026-11-23T00:00:00Z")
    let cached: Record<string, unknown> = { status: "ok", listings: [], affiliate: false, fetchedAt: new Date(at).toISOString() }
    // A cache hit: what stale-while-revalidate hands back, whatever its age.
    vi.doMock("next/cache", () => ({ unstable_cache: () => async () => cached }))
    vi.doMock("@/lib/abuse/anon-rate", () => ({ bumpAnonRates: vi.fn() }))
    const { getPaperListings } = await import("@/lib/physical/ebay-listings-cached")
    const H = 3_600_000
    expect((await getPaperListings("Cooper Flagg", "cooper-flagg", at + 5 * H)).status).toBe("ok")
    expect((await getPaperListings("Cooper Flagg", "cooper-flagg", at + 6 * H)).status).toBe("ok")
    expect(await getPaperListings("Cooper Flagg", "cooper-flagg", at + 6 * H + 1000)).toEqual({ status: "error" })
    cached = { status: "ok", listings: [], affiliate: false }
    expect(await getPaperListings("Cooper Flagg", "cooper-flagg", at)).toEqual({ status: "error" })
  })
})

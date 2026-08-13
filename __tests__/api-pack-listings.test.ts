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

  // ── Failure path ──────────────────────────────────────────────────────────
  //
  // This block used to read `expect(body.error).toBe("dapper down")` — it
  // asserted the LEAK, which made the defect look like the contract. The
  // property that actually matters is the opposite one: whatever the upstream
  // said must NOT reach the client. fetchLivePackListings rethrows Dapper
  // Studio's own GraphQL message verbatim, so that string is third-party text.
  it("does not publish the upstream message when the fetch helper throws", async () => {
    state.throwErr = new Error("dapper down: internal schema field xyz missing")
    const res = await GET(req("https://t/api/pack-listings"))
    const body = await res.json()
    expect(body.error).not.toContain("dapper down")
    expect(body.error).not.toContain("internal schema field")
    expect(body.error).toBe("Pack listings are unavailable right now.")
    expect(body.code).toBe("internal")
    expect(res.status).toBe(500)
  })

  it("does not edge-cache the failure", async () => {
    // The failure must not be held at the CDN: pinning a momentary upstream
    // blip into a sustained one is the exact hazard apiErrorResponse's
    // no-store exists to prevent.
    state.throwErr = new Error("dapper down")
    const res = await GET(req("https://t/api/pack-listings"))
    expect(res.headers.get("Cache-Control")).toBe("no-store")
  })

  it("reports a database-class timeout as a retryable 503, not a hard 500", async () => {
    // A 500 puts transient capacity into the hard-5xx budget that pages on
    // genuine breakage. safeApiError classifies on SQLSTATE first.
    state.throwErr = Object.assign(new Error("canceling statement due to statement timeout"), {
      code: "57014",
    })
    const res = await GET(req("https://t/api/pack-listings"))
    const body = await res.json()
    expect(res.status).toBe(503)
    expect(body.code).toBe("timeout")
    expect(body.retryable).toBe(true)
    expect(res.headers.get("Retry-After")).toBe("30")
    expect(body.error).not.toContain("canceling statement")
  })

  // The 400 is a CALLER error, not a driver message — its copy names the
  // allowed collections and PackPageClient documents that branch as
  // intentional. It must survive the failure-path change untouched.
  it("keeps the actionable 400 copy for an unsupported collection", async () => {
    const res = await GET(req("https://t/api/pack-listings?collection=disney-pinnacle"))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain("nba-top-shot")
    expect(body.error).toContain("nfl-all-day")
  })
})

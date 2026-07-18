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

// Pinnacle Market reuses the Sniper's live-listings compute (2026-07-18). Mock it
// so the disney-pinnacle dispatch (fetchPinnacleModernListings) + the modern
// enrich/reshape path (incl. the ASK_ONLY thin-data guard) are exercised.
vi.mock("@/lib/sniper/pinnacle", () => ({
  computePinnacleSniperFeed: vi.fn(),
}))

import { GET } from "@/app/api/market/route"
import { computePinnacleSniperFeed } from "@/lib/sniper/pinnacle"

const req = (u: string) => ({ nextUrl: new URL(u) }) as any

const GOLAZOS = "06248cc4-b85f-47cd-af67-1855d14acd75"
const PINNACLE = "7dd9dd11-e8b6-45c4-ac99-71331f959714"

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

  it("dispatches Disney Pinnacle to computePinnacleSniperFeed and reshapes its listings", async () => {
    ;(computePinnacleSniperFeed as any).mockResolvedValue({
      deals: [
        {
          listingResourceID: 111, flowId: 999, momentId: "m1",
          playerName: "Mickey Mouse", teamName: "Disney", setName: "Series 1", seriesName: "2024",
          tier: "Standard", serial: 5, circulationCount: 100,
          askPrice: 10, adjustedFmv: 20, discount: 50,
          confidence: "high", source: "pinnacle", buyUrl: "https://flowty/x",
          thumbnailUrl: "https://img/x", storefrontAddress: "0xabc", isLocked: false,
          updatedAt: "2026-07-18T00:00:00Z",
        },
        {
          // ASK_ONLY (lowercased confidence) — must be flagged thin-data, its fake
          // discount suppressed. Exercises the case-insensitive guard.
          listingResourceID: 222, flowId: 998, momentId: "m2",
          playerName: "Donald Duck", teamName: "Disney", setName: "Series 1", seriesName: "2024",
          tier: "Brushed Silver", serial: 1, circulationCount: 50,
          askPrice: 12, adjustedFmv: 385, discount: 97,
          confidence: "ask_only", source: "pinnacle", buyUrl: "https://flowty/y",
          thumbnailUrl: "https://img/y", storefrontAddress: "0xdef", isLocked: false,
          updatedAt: "2026-07-18T00:00:00Z",
        },
      ],
    })

    const res = await GET(req(`https://t/api/market?collectionId=${PINNACLE}`))
    expect(res.status).toBe(200)
    expect(computePinnacleSniperFeed).toHaveBeenCalled()
    const body = await res.json()
    expect(body.diagnostics.source).toBe("modern")
    expect(body.pagination.total).toBe(2)
    expect(body.listings).toHaveLength(2)

    const mickey = body.listings.find((l: any) => l.playerName === "Mickey Mouse")
    const donald = body.listings.find((l: any) => l.playerName === "Donald Duck")
    expect(mickey).toMatchObject({ collectionId: PINNACLE, source: "pinnacle", askPrice: 10, tier: "Standard" })
    expect(mickey.lowConfidenceFmv).toBe(false)
    // ASK_ONLY row: flagged thin-data so the UI shows "⚠ thin data" instead of a fake discount.
    expect(donald.lowConfidenceFmv).toBe(true)
  })
})

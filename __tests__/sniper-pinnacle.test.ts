// Unit tests for lib/sniper/pinnacle.ts — computePinnacleSniperFeed. Drives the
// feed assembly: FMV-map load (incl. the error branch → empty map), NFT dedup,
// the variant/maxPrice/minDiscount/player filters, each sort mode, the 200-row
// slice, and the PinnacleSniperDeal → SniperDeal field remap. @/lib/supabase is
// mocked as a thenable query builder (loadFmvMap); @/lib/pinnacle/pinnacleFlowty
// is mocked so we control the raw NFTs and the per-NFT deals directly.

import { describe, it, expect, beforeEach, vi } from "vitest"

const state: { query: { data: any; error: any }; nfts: any[] } = {
  query: { data: [], error: null },
  nfts: [],
}

vi.mock("@/lib/supabase", () => {
  const build = () => {
    const b: any = {}
    for (const m of ["select", "not", "order", "eq", "in", "limit", "is"]) b[m] = () => b
    b.then = (resolve: any) => resolve(state.query)
    return b
  }
  const client: any = { from: () => build() }
  return { supabase: client, supabaseAdmin: client }
})

vi.mock("@/lib/pinnacle/pinnacleFlowty", () => ({
  // Only the offset-0 page returns NFTs; the other 3 pages are empty. Each NFT
  // carries a `__deals` payload that our flowtyNftToSniperDeals mock returns.
  fetchFlowtyPinnacleListings: vi.fn(async (o: any) => (o.offset === 0 ? state.nfts : [])),
  flowtyNftToSniperDeals: (nft: any) => nft.__deals ?? [],
}))

import { computePinnacleSniperFeed } from "@/lib/sniper/pinnacle"

// Minimal PinnacleSniperDeal with only the fields computePinnacleSniperFeed reads.
function mkDeal(o: Partial<Record<string, any>> = {}) {
  return {
    flowId: o.flowId ?? "f1",
    nftId: o.nftId ?? "n1",
    editionKey: o.editionKey ?? "R1:Standard:1",
    characterName: o.characterName ?? "Grogu",
    franchise: o.franchise ?? "Star Wars",
    setName: o.setName ?? "Mandalorian",
    seriesYear: o.seriesYear ?? 2024,
    variantType: o.variantType ?? "Standard",
    serial: o.serial ?? null,
    mintCount: o.mintCount ?? 100,
    askPrice: o.askPrice ?? 50,
    baseFmv: o.baseFmv ?? 80,
    adjustedFmv: o.adjustedFmv ?? 80,
    discount: o.discount ?? 30,
    confidence: o.confidence ?? "HIGH",
    serialMult: o.serialMult ?? 1,
    isSpecialSerial: o.isSpecialSerial ?? false,
    serialSignal: o.serialSignal ?? null,
    thumbnailUrl: o.thumbnailUrl ?? "http://img/1.png",
    isLocked: o.isLocked ?? false,
    updatedAt: o.updatedAt ?? "2026-07-01T00:00:00.000Z",
    buyUrl: o.buyUrl ?? "https://disneypinnacle.com/marketplace",
    listingResourceID: o.listingResourceID ?? "lr1",
    listingOrderID: o.listingOrderID ?? null,
    storefrontAddress: o.storefrontAddress ?? "0xsf",
    offerAmount: o.offerAmount ?? null,
    offerFmvPct: o.offerFmvPct ?? null,
  }
}

function nft(id: string, deals: any[]) {
  return { id, __deals: deals }
}

beforeEach(() => {
  state.query = { data: [], error: null }
  state.nfts = []
  vi.clearAllMocks()
})

describe("computePinnacleSniperFeed", () => {
  it("returns an empty feed when there are no listed NFTs", async () => {
    const res = await computePinnacleSniperFeed()
    expect(res.count).toBe(0)
    expect(res.deals).toEqual([])
    expect(res.tsCount).toBe(0)
    expect(res.flowtyCount).toBe(0)
    expect(typeof res.lastRefreshed).toBe("string")
  })

  it("loads the FMV map from pinnacle_catalog (fmvCoverage = distinct legacy keys)", async () => {
    state.query = {
      data: [
        { legacy_edition_key: "A", fmv_usd: 10, fmv_confidence: "HIGH", fmv_sales_count_30d: 5 },
        { legacy_edition_key: "A", fmv_usd: 9, fmv_confidence: "HIGH", fmv_sales_count_30d: 4 }, // dupe key ignored
        { legacy_edition_key: "B", fmv_usd: 20, fmv_confidence: "MEDIUM", fmv_sales_count_30d: 1 },
        { legacy_edition_key: null, fmv_usd: 5, fmv_confidence: "LOW", fmv_sales_count_30d: 0 }, // null key skipped
      ],
      error: null,
    }
    const res = await computePinnacleSniperFeed()
    expect(res.fmvCoverage).toBe(2)
  })

  it("returns an empty FMV map (coverage 0) when the catalog query errors", async () => {
    state.query = { data: null, error: { message: "db down" } }
    state.nfts = [nft("n1", [mkDeal()])]
    const res = await computePinnacleSniperFeed()
    expect(res.fmvCoverage).toBe(0)
    expect(res.count).toBe(1)
  })

  it("dedups NFTs by id before mapping to deals", async () => {
    state.nfts = [nft("dup", [mkDeal({ flowId: "a" })]), nft("dup", [mkDeal({ flowId: "b" })])]
    const res = await computePinnacleSniperFeed()
    expect(res.flowtyCount).toBe(1)
    expect(res.count).toBe(1)
  })

  it("filters by variant (tier alias), case-insensitively", async () => {
    state.nfts = [
      nft("n1", [mkDeal({ nftId: "std", variantType: "Standard" })]),
      nft("n2", [mkDeal({ nftId: "hex", variantType: "Hexwave" })]),
    ]
    const res = await computePinnacleSniperFeed({ variantFilter: "hexwave" })
    expect(res.count).toBe(1)
    expect(res.deals[0].tier).toBe("Hexwave")
  })

  it("filters by maxPrice and minDiscount", async () => {
    state.nfts = [
      nft("cheap", [mkDeal({ nftId: "cheap", askPrice: 40, discount: 60 })]),
      nft("pricey", [mkDeal({ nftId: "pricey", askPrice: 90, discount: 10 })]),
    ]
    const byPrice = await computePinnacleSniperFeed({ maxPrice: 50 })
    expect(byPrice.deals.map((d) => d.momentId)).toEqual(["cheap"])
    const byDiscount = await computePinnacleSniperFeed({ minDiscount: 50 })
    expect(byDiscount.deals.map((d) => d.momentId)).toEqual(["cheap"])
  })

  it("filters by player across character/franchise/set", async () => {
    state.nfts = [
      nft("n1", [mkDeal({ nftId: "grogu", characterName: "Grogu", franchise: "Star Wars", setName: "Mando" })]),
      nft("n2", [mkDeal({ nftId: "mickey", characterName: "Mickey", franchise: "Disney", setName: "Classic" })]),
    ]
    const res = await computePinnacleSniperFeed({ playerFilter: "star wars" })
    expect(res.deals.map((d) => d.momentId)).toEqual(["grogu"])
  })

  it("sorts by discount desc by default", async () => {
    state.nfts = [
      nft("lo", [mkDeal({ nftId: "lo", discount: 10 })]),
      nft("hi", [mkDeal({ nftId: "hi", discount: 90 })]),
    ]
    const res = await computePinnacleSniperFeed()
    expect(res.deals.map((d) => d.momentId)).toEqual(["hi", "lo"])
  })

  it("supports price_asc / price_desc / fmv_desc / listed_desc sorts", async () => {
    const build = () => [
      nft("a", [mkDeal({ nftId: "a", askPrice: 30, adjustedFmv: 100, updatedAt: "2026-07-01T00:00:00.000Z" })]),
      nft("b", [mkDeal({ nftId: "b", askPrice: 70, adjustedFmv: 200, updatedAt: "2026-07-03T00:00:00.000Z" })]),
    ]
    state.nfts = build()
    expect((await computePinnacleSniperFeed({ sortBy: "price_asc" })).deals.map((d) => d.momentId)).toEqual(["a", "b"])
    state.nfts = build()
    expect((await computePinnacleSniperFeed({ sortBy: "price_desc" })).deals.map((d) => d.momentId)).toEqual(["b", "a"])
    state.nfts = build()
    expect((await computePinnacleSniperFeed({ sortBy: "fmv_desc" })).deals.map((d) => d.momentId)).toEqual(["b", "a"])
    state.nfts = build()
    expect((await computePinnacleSniperFeed({ sortBy: "listed_desc" })).deals.map((d) => d.momentId)).toEqual(["b", "a"])
  })

  it("caps the output at 200 deals", async () => {
    const deals = Array.from({ length: 250 }, (_, i) => mkDeal({ nftId: `d${i}`, discount: i }))
    state.nfts = [nft("big", deals)]
    const res = await computePinnacleSniperFeed()
    expect(res.count).toBe(200)
    expect(res.deals.length).toBe(200)
  })

  it("remaps a PinnacleSniperDeal onto the unified SniperDeal shape", async () => {
    state.nfts = [
      nft("n1", [
        mkDeal({
          nftId: "n1",
          characterName: "Grogu",
          franchise: "Star Wars",
          setName: "Mando",
          variantType: "Hexwave",
          seriesYear: 2024,
          serial: 7,
          mintCount: 100,
          confidence: "HIGH",
          discount: 42,
        }),
      ],
    )]
    const res = await computePinnacleSniperFeed()
    const d = res.deals[0]
    expect(d).toMatchObject({
      momentId: "n1",
      playerName: "Grogu",
      teamName: "Star Wars",
      setName: "Mando",
      seriesName: "2024",
      tier: "Hexwave",
      serial: 7,
      circulationCount: 100,
      confidence: "high", // lowercased
      confidenceSource: "rpc_fmv",
      source: "pinnacle",
      paymentToken: "DUC",
      discount: 42,
      dealRating: 42,
    })
  })
})

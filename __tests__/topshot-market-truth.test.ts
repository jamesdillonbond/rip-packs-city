import { describe, it, expect, vi, beforeEach } from "vitest"

// Locks in lib/topshot-market-truth.ts::getTopShotMarketTruth — the truth-probe
// assembler that reconciles observed wallet values against live Top Shot GraphQL
// probes. These tests pin the probeStatus state machine (observed-only /
// docs-probe-success / -partial / -failed), the marketBacked{Ask,LastSale,
// BestOffer} fallback ladders, observedSourceCount, jersey/offer merges, and
// error resilience. The cache is passed through and topshotGraphql is mocked so
// each probe branch (success / partial / failed / null-payload) is deterministic.

const topshotGraphql = vi.fn()

vi.mock("@/lib/cache", () => ({
  getOrSetCache: async (_k: string, _ttl: number, fn: () => any) => fn(),
}))

vi.mock("@/lib/topshot", () => ({
  topshotGraphql: (...args: any[]) => topshotGraphql(...args),
}))

import { getTopShotMarketTruth } from "@/lib/topshot-market-truth"

// Payload builders keyed off the query the route sends.
function marketplacePayload(edition: any) {
  return {
    searchMarketplaceEditions: {
      data: { searchSummary: { data: { data: edition === null ? [] : [edition] } } },
    },
  }
}
function transactionsPayload(prices: number[]) {
  return {
    searchMarketplaceTransactions: {
      data: {
        searchSummary: { data: [{ data: prices.map((price) => ({ price, updatedAt: "x" })) }] },
      },
    },
  }
}
function offersPayload(prices: number[]) {
  return { getTopOffers: { offers: prices.map((price) => ({ price, offerType: "Edition" })) } }
}

// Route topshotGraphql by inspecting the query text.
function routeMock(opts: {
  marketplace?: any
  transactions?: any
  offers?: any
}) {
  topshotGraphql.mockImplementation(async (query: string) => {
    if (query.includes("searchMarketplaceEditions")) {
      if (opts.marketplace instanceof Error) throw opts.marketplace
      return opts.marketplace
    }
    if (query.includes("searchMarketplaceTransactions")) {
      if (opts.transactions instanceof Error) throw opts.transactions
      return opts.transactions
    }
    if (query.includes("getTopOffers")) {
      if (opts.offers instanceof Error) throw opts.offers
      return opts.offers
    }
    return null
  })
}

beforeEach(() => {
  topshotGraphql.mockReset()
  delete process.env.ENABLE_TOPSHOT_DOCS_PROBES
})

describe("getTopShotMarketTruth — observed-only (probes disabled)", () => {
  it("uses input values, no GraphQL calls, status observed-only", async () => {
    const r = await getTopShotMarketTruth({
      editionKey: "73:2785",
      bestAsk: 10,
      lastPurchasePrice: 5,
    })
    expect(topshotGraphql).not.toHaveBeenCalled()
    expect(r.probeStatus).toBe("observed-only")
    expect(r.setId).toBe("73")
    expect(r.playId).toBe("2785")
    expect(r.marketBackedAsk).toBe(10)
    expect(r.marketBackedLastSale).toBe(5)
    expect(r.marketBackedBestOffer).toBeNull()
    expect(r.observedSourceCount).toBe(2)
    expect(r.sourceSummary).toBe("Observed values only")
    expect(r.probeNotes).toEqual([])
  })

  it("observedSourceCount 0 when no inputs and no probes", async () => {
    const r = await getTopShotMarketTruth({
      editionKey: null,
      bestAsk: null,
      lastPurchasePrice: null,
    })
    expect(r.setId).toBeNull()
    expect(r.playId).toBeNull()
    expect(r.observedSourceCount).toBe(0)
    expect(r.probeStatus).toBe("observed-only")
  })

  it("null editionKey skips probes even when the flag is on", async () => {
    process.env.ENABLE_TOPSHOT_DOCS_PROBES = "true"
    const r = await getTopShotMarketTruth({
      editionKey: null,
      bestAsk: 7,
      lastPurchasePrice: null,
    })
    expect(topshotGraphql).not.toHaveBeenCalled()
    expect(r.probeStatus).toBe("observed-only")
    expect(r.marketBackedAsk).toBe(7)
    expect(r.observedSourceCount).toBe(1)
  })
})

describe("getTopShotMarketTruth — docs-probe-success", () => {
  it("all three probes return data → success, market-backed from live probes", async () => {
    process.env.ENABLE_TOPSHOT_DOCS_PROBES = "true"
    routeMock({
      marketplace: marketplacePayload({
        lowAsk: 42,
        highestOffer: 30,
        priceRange: { min: 40, max: 90 },
        editionListingCount: 12,
        averageSaleData: { averagePrice: 55 },
        marketplaceStats: { averageSalePrice: 60, highestOffer: 31 },
        play: { stats: { jerseyNumber: 7 } },
      }),
      transactions: transactionsPayload([88, 70]),
      offers: offersPayload([25, 29]),
    })

    const r = await getTopShotMarketTruth({
      editionKey: "73:2785",
      bestAsk: 999,
      lastPurchasePrice: 111,
    })

    expect(r.probeStatus).toBe("docs-probe-success")
    expect(r.sourceSummary).toBe("Top Shot live market data")
    expect(r.editionListingFloor).toBe(42)
    expect(r.editionListingCount).toBe(12)
    expect(r.editionAverageSale).toBe(55)
    expect(r.editionLatestSale).toBe(88) // first (most recent) tx price
    expect(r.jerseyNumber).toBe(7)
    // marketplace highestOffer (30) already set, so topOffers max is NOT applied
    expect(r.editionOfferMax).toBe(30)
    // market-backed prefers live probe over observed input
    expect(r.marketBackedAsk).toBe(42)
    expect(r.marketBackedLastSale).toBe(88)
    expect(r.marketBackedBestOffer).toBe(30)
    expect(r.observedSourceCount).toBe(3)
    expect(r.probeNotes).toEqual([])
  })

  it("topOffers fills editionOfferMax when marketplace highestOffer is null", async () => {
    process.env.ENABLE_TOPSHOT_DOCS_PROBES = "true"
    routeMock({
      marketplace: marketplacePayload({
        lowAsk: 20,
        highestOffer: null,
        marketplaceStats: { highestOffer: null },
      }),
      transactions: transactionsPayload([15]),
      offers: offersPayload([9, 33, 21]),
    })
    const r = await getTopShotMarketTruth({
      editionKey: "1:1",
      bestAsk: null,
      lastPurchasePrice: null,
    })
    expect(r.probeStatus).toBe("docs-probe-success")
    expect(r.editionOfferMax).toBe(33) // Math.max of topOffers
    expect(r.marketBackedBestOffer).toBe(33)
  })

  it("floor falls back to priceRange.min and average to marketplaceStats", async () => {
    process.env.ENABLE_TOPSHOT_DOCS_PROBES = "true"
    routeMock({
      marketplace: marketplacePayload({
        lowAsk: null,
        priceRange: { min: 17, max: 50 },
        averageSaleData: null,
        marketplaceStats: { averageSalePrice: 44 },
      }),
      transactions: transactionsPayload([]),
      offers: offersPayload([]),
    })
    const r = await getTopShotMarketTruth({
      editionKey: "2:2",
      bestAsk: 500,
      lastPurchasePrice: 300,
    })
    expect(r.editionListingFloor).toBe(17)
    expect(r.editionAverageSale).toBe(44)
    // no latest sale from probe → falls to average, not the observed input
    expect(r.editionLatestSale).toBeNull()
    expect(r.marketBackedLastSale).toBe(44)
  })
})

describe("getTopShotMarketTruth — docs-probe-partial", () => {
  it("one probe throws → partial, note recorded, fallback ladder used", async () => {
    process.env.ENABLE_TOPSHOT_DOCS_PROBES = "true"
    routeMock({
      marketplace: marketplacePayload({
        lowAsk: 25,
        averageSaleData: { averagePrice: 40 },
      }),
      transactions: new Error("tx boom"),
      offers: offersPayload([12]),
    })
    const r = await getTopShotMarketTruth({
      editionKey: "5:9",
      bestAsk: 100,
      lastPurchasePrice: 77,
    })
    expect(r.probeStatus).toBe("docs-probe-partial")
    expect(r.sourceSummary).toBe("Top Shot partial market data")
    expect(r.editionLatestSale).toBeNull()
    // lastSale ladder: latest(null) → average(40)
    expect(r.marketBackedLastSale).toBe(40)
    expect(r.editionOfferMax).toBe(12)
    expect(r.probeNotes).toHaveLength(1)
    expect(r.probeNotes[0]).toContain("recentSales")
    expect(r.probeNotes[0]).toContain("tx boom")
  })
})

describe("getTopShotMarketTruth — docs-probe-failed", () => {
  it("all three probes throw → failed, three notes, observed fallbacks", async () => {
    process.env.ENABLE_TOPSHOT_DOCS_PROBES = "true"
    routeMock({
      marketplace: new Error("mp"),
      transactions: new Error("tx"),
      offers: new Error("off"),
    })
    const r = await getTopShotMarketTruth({
      editionKey: "8:133",
      bestAsk: 50,
      lastPurchasePrice: 20,
    })
    expect(r.probeStatus).toBe("docs-probe-failed")
    expect(r.sourceSummary).toBe("Top Shot probes failed")
    expect(r.probeNotes).toHaveLength(3)
    // every edition* stayed null → fall back to observed inputs
    expect(r.editionListingFloor).toBeNull()
    expect(r.marketBackedAsk).toBe(50)
    expect(r.marketBackedLastSale).toBe(20)
    expect(r.marketBackedBestOffer).toBeNull()
    expect(r.observedSourceCount).toBe(2)
  })

  it("non-Error throw yields the generic 'failed' note text", async () => {
    process.env.ENABLE_TOPSHOT_DOCS_PROBES = "true"
    topshotGraphql.mockImplementation(async () => {
      throw "string-error"
    })
    const r = await getTopShotMarketTruth({
      editionKey: "8:133",
      bestAsk: null,
      lastPurchasePrice: null,
    })
    expect(r.probeStatus).toBe("docs-probe-failed")
    expect(r.probeNotes.every((n) => n.endsWith("failed"))).toBe(true)
  })
})

describe("getTopShotMarketTruth — null-payload resilience", () => {
  it("probes return null/empty (no throw) → success status with null probe data", async () => {
    process.env.ENABLE_TOPSHOT_DOCS_PROBES = "true"
    routeMock({
      marketplace: marketplacePayload(null), // empty editions array
      transactions: transactionsPayload([]),
      offers: offersPayload([]),
    })
    const r = await getTopShotMarketTruth({
      editionKey: "3:3",
      bestAsk: 8,
      lastPurchasePrice: 4,
    })
    // no throws → success even though every probe produced nulls
    expect(r.probeStatus).toBe("docs-probe-success")
    expect(r.editionListingFloor).toBeNull()
    expect(r.editionLatestSale).toBeNull()
    expect(r.editionOfferMax).toBeNull()
    // market-backed values fall through to observed inputs
    expect(r.marketBackedAsk).toBe(8)
    expect(r.marketBackedLastSale).toBe(4)
    expect(r.observedSourceCount).toBe(2)
  })

  it("topshotGraphql returning literal null does not crash the probes", async () => {
    process.env.ENABLE_TOPSHOT_DOCS_PROBES = "true"
    topshotGraphql.mockResolvedValue(null)
    const r = await getTopShotMarketTruth({
      editionKey: "4:4",
      bestAsk: null,
      lastPurchasePrice: null,
    })
    expect(r.probeStatus).toBe("docs-probe-success")
    expect(r.observedSourceCount).toBe(0)
  })
})

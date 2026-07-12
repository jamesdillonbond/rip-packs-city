import { describe, it, expect, vi } from "vitest"

// Locks in lib/flowscan-market-truth.ts::getMarketTruth — the normalize/merge
// layer that groups raw market rows by editionKey::parallel and derives an
// editionLowAsk (min of asks) / lastSale (max of sales) FMV ladder. Pins the
// scope-key construction, the ask-wins-over-sale precedence, count/null
// coercion, empty-input resilience, and the "no market inputs" branch.
// @/lib/cache is mocked pass-through because getMarketTruth caches under a
// single constant key, which would otherwise leak state across tests.

vi.mock("@/lib/cache", () => ({
  getOrSetCache: async (_k: string, _ttl: number, fn: () => Promise<unknown>) => fn(),
}))

import { getMarketTruth } from "@/lib/flowscan-market-truth"

describe("getMarketTruth — empty / no-signal branches", () => {
  it("empty input → empty map", async () => {
    const map = await getMarketTruth([])
    expect(map.size).toBe(0)
  })

  it("row with no ask and no sale → fmv null, method/source 'none'", async () => {
    const map = await getMarketTruth([
      { editionKey: "1:2", parallel: "Base", bestAsk: null, lastPurchasePrice: null },
    ])
    const t = map.get("1:2::Base")!
    expect(t).toBeDefined()
    expect(t.fmv).toBeNull()
    expect(t.fmvMethod).toBe("none")
    expect(t.marketSource).toBe("none")
    expect(t.confidence).toBe("low")
    expect(t.reason).toBe("No market inputs")
    expect(t.askCount).toBe(0)
    expect(t.saleCount).toBe(0)
    expect(t.offerCount).toBe(0)
  })
})

describe("getMarketTruth — ask path (live-row-aggregate)", () => {
  it("min ask wins as editionLowAsk and drives fmv", async () => {
    const map = await getMarketTruth([
      { editionKey: "8:133", parallel: "Base", bestAsk: 90 },
      { editionKey: "8:133", parallel: "Base", bestAsk: 55 },
    ])
    expect(map.size).toBe(1)
    const t = map.get("8:133::Base")!
    expect(t.editionLowAsk).toBe(55)
    expect(t.rowLowAsk).toBe(55)
    expect(t.fmv).toBe(55)
    expect(t.fmvMethod).toBe("edition-low-ask")
    expect(t.marketSource).toBe("live-row-aggregate")
    expect(t.confidence).toBe("high")
    expect(t.reason).toBe("Using edition low ask")
    expect(t.askCount).toBe(2)
    // offers are never populated by this source
    expect(t.editionOffer).toBeNull()
    expect(t.rowOffer).toBeNull()
    expect(t.offerCount).toBe(0)
  })

  it("ask wins over sale (precedence) even when a sale is present", async () => {
    const map = await getMarketTruth([
      { editionKey: "9:9", parallel: "Base", bestAsk: 100, lastPurchasePrice: 500 },
    ])
    const t = map.get("9:9::Base")!
    expect(t.fmv).toBe(100)
    expect(t.fmvMethod).toBe("edition-low-ask")
    expect(t.lastSale).toBe(500)
    expect(t.saleCount).toBe(1)
  })

  it("a zero ask is a real signal (0 !== null), not treated as missing", async () => {
    const map = await getMarketTruth([
      { editionKey: "3:3", parallel: "Base", bestAsk: 0 },
    ])
    const t = map.get("3:3::Base")!
    expect(t.editionLowAsk).toBe(0)
    expect(t.fmv).toBe(0)
    expect(t.fmvMethod).toBe("edition-low-ask")
  })
})

describe("getMarketTruth — sale fallback path (edition-sale)", () => {
  it("no asks → highest sale becomes lastSale + fmv", async () => {
    const map = await getMarketTruth([
      { editionKey: "7:7", parallel: "Base", lastPurchasePrice: 10 },
      { editionKey: "7:7", parallel: "Base", lastPurchasePrice: 50 },
      { editionKey: "7:7", parallel: "Base", lastPurchasePrice: 30 },
    ])
    const t = map.get("7:7::Base")!
    expect(t.lastSale).toBe(50)
    expect(t.fmv).toBe(50)
    expect(t.fmvMethod).toBe("edition-last-sale")
    expect(t.marketSource).toBe("edition-sale")
    expect(t.confidence).toBe("low")
    expect(t.reason).toBe("Using last sale fallback")
    expect(t.saleCount).toBe(3)
    expect(t.askCount).toBe(0)
  })
})

describe("getMarketTruth — scope-key construction", () => {
  it("key is `${editionKey}::${parallel}` and parallels split into groups", async () => {
    const map = await getMarketTruth([
      { editionKey: "5:5", parallel: "Hexwave", bestAsk: 1 },
      { editionKey: "5:5", parallel: "Base", bestAsk: 2 },
    ])
    expect(map.size).toBe(2)
    expect(map.get("5:5::Hexwave")!.fmv).toBe(1)
    expect(map.get("5:5::Base")!.fmv).toBe(2)
  })

  it("null editionKey collapses to the 'unknown' sentinel key", async () => {
    const map = await getMarketTruth([
      { editionKey: null, parallel: "Base", bestAsk: 5 },
    ])
    const t = map.get("unknown::Base")!
    expect(t).toBeDefined()
    expect(t.scopeKey).toBe("unknown::Base")
    expect(t.fmv).toBe(5)
  })
})

import { describe, it, expect } from "vitest"
import { buildLiveEditionMarketMap, type LiveMarketInputRow } from "@/lib/edition-market-live"

// lib/edition-market-live.ts aggregates currently-loaded live rows into one
// resolved market per edition scope: lowAsk = min across rows (and min(lowAsk,
// bestAsk) within a row), bestOffer = max, lastSale = median of purchases. These
// aggregation rules drive the on-page live FMV strip; previously untested.

const row = (o: Partial<LiveMarketInputRow>): LiveMarketInputRow => ({
  momentId: o.momentId ?? "m",
  editionKey: o.editionKey ?? "84:2892",
  ...o,
})

describe("buildLiveEditionMarketMap", () => {
  it("returns an empty map for no rows", () => {
    expect(buildLiveEditionMarketMap([]).size).toBe(0)
  })

  it("aggregates ask as the minimum and offer as the maximum across rows in one scope", () => {
    const map = buildLiveEditionMarketMap([
      row({ momentId: "a", lowAsk: 30, bestOffer: 10 }),
      row({ momentId: "b", lowAsk: 22, bestOffer: 18 }),
    ])
    expect(map.size).toBe(1)
    const [resolved] = [...map.values()]
    expect(resolved.lowAsk).toBe(22) // min of 30, 22
    expect(resolved.bestOffer).toBe(18) // max of 10, 18
    expect(resolved.askCount).toBe(2)
    expect(resolved.offerCount).toBe(2)
  })

  it("uses the lower of lowAsk and bestAsk within a single row", () => {
    const map = buildLiveEditionMarketMap([row({ lowAsk: 40, bestAsk: 25, bestOffer: null })])
    expect([...map.values()][0].lowAsk).toBe(25)
  })

  it("reports lastSale as the median of purchase prices, rounded to 2dp", () => {
    const map = buildLiveEditionMarketMap([
      row({ momentId: "a", lastPurchasePrice: 10 }),
      row({ momentId: "b", lastPurchasePrice: 20 }),
      row({ momentId: "c", lastPurchasePrice: 33 }),
    ])
    const r = [...map.values()][0]
    expect(r.saleCount).toBe(3)
    expect(r.lastSale).toBe(20) // median of 10,20,33
  })

  it("averages the two middle sales for an even count", () => {
    const map = buildLiveEditionMarketMap([
      row({ momentId: "a", lastPurchasePrice: 10 }),
      row({ momentId: "b", lastPurchasePrice: 15 }),
    ])
    expect([...map.values()][0].lastSale).toBe(12.5)
  })

  it("leaves absent inputs null rather than zero", () => {
    const map = buildLiveEditionMarketMap([row({ lowAsk: null, bestOffer: null, lastPurchasePrice: null })])
    const r = [...map.values()][0]
    expect(r.lowAsk).toBeNull()
    expect(r.bestOffer).toBeNull()
    expect(r.lastSale).toBeNull()
    expect(r.askCount).toBe(0)
  })

  it("keeps distinct edition scopes in separate entries", () => {
    const map = buildLiveEditionMarketMap([
      row({ momentId: "a", editionKey: "84:2892", lowAsk: 10 }),
      row({ momentId: "b", editionKey: "99:1234", lowAsk: 20 }),
    ])
    expect(map.size).toBe(2)
  })
})

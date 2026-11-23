import { describe, it, expect } from "vitest"
import { valueRange, isConfirmedPaid, type PhysicalSale } from "@/lib/physical/valuation-range"
import { backtestCard, passes } from "@/lib/physical/backtest"
import {
  decodeCourtyardTrade,
  comparablePrice,
  readCourtyardTrades,
  COURTYARD,
  type RawLog,
} from "@/lib/physical/courtyard-trades"
import { buildBrowseRequest, mapBrowseResponse } from "@/lib/physical/ebay-browse"
import { parseCertInput, mapHciCert, psaLookupSucceeded } from "@/lib/physical/cert"
import { boxEv, parseOdds } from "@/lib/physical/box-ev"

// Physical-cards prototype (unwired). Locks the valuation rules the scoping
// doc commits to, the Courtyard decoder against a REAL log captured from
// Polygon on 2026-11-22, and the request/response mappers.

const sale = (daysAgo: number, price: number, extra: Partial<PhysicalSale> = {}): PhysicalSale => ({
  soldAt: new Date(Date.parse("2026-11-22T00:00:00Z") - daysAgo * 86_400_000).toISOString(),
  price,
  grader: "psa",
  grade: "10",
  saleType: "auction",
  ...extra,
})
const asOf = "2026-11-22T00:00:00Z"

describe("valueRange", () => {
  it("medians the recent exact-grade sales and returns a range", () => {
    const r = valueRange([sale(1, 100), sale(2, 110), sale(3, 90), sale(4, 105), sale(5, 95)], "psa", "10", { asOf })
    expect(r.status).toBe("ok")
    expect(r.point).toBe(100)
    expect(r.low).toBe(95)
    expect(r.high).toBe(105)
  })

  it("never borrows across graders or grades", () => {
    const r = valueRange(
      [sale(1, 100), sale(2, 100), sale(3, 500, { grader: "bgs", grade: "9.5" }), sale(4, 40, { grade: "9" })],
      "psa",
      "10",
      { asOf },
    )
    expect(r.status).toBe("insufficient")
  })

  it("drops a best-offer row that reports the ask, keeps a real accepted offer", () => {
    expect(isConfirmedPaid(sale(1, 100, { saleType: "best_offer", askingPrice: 100 }))).toBe(false)
    expect(isConfirmedPaid(sale(1, 80, { saleType: "best_offer", askingPrice: 100 }))).toBe(true)
    expect(isConfirmedPaid(sale(1, 80, { saleType: "best_offer", askingPrice: null }))).toBe(false)
  })

  it("excludes outliers before the median", () => {
    const r = valueRange([sale(1, 100), sale(2, 100), sale(3, 100), sale(4, 1000)], "psa", "10", { asOf })
    expect(r.point).toBe(100)
    expect(r.notes.join()).toMatch(/outlier/)
  })

  it("caps a stale value at the last sale", () => {
    const r = valueRange([sale(40, 60), sale(50, 100), sale(60, 100)], "psa", "10", { asOf })
    expect(r.stale).toBe(true)
    expect(r.point).toBe(60)
    expect(r.internalConfidence).toBe("low")
  })

  it("ignores sales after asOf", () => {
    const r = valueRange([sale(-1, 999), sale(1, 100), sale(2, 100), sale(3, 100)], "psa", "10", { asOf })
    expect(r.point).toBe(100)
  })
})

describe("backtestCard", () => {
  it("scores only on sales the estimate never saw", () => {
    const sales = [10, 9, 8, 7, 6, 5, 4, 3, 2, 1].map((d) => sale(d, 100 + (d % 3)))
    const s = backtestCard(sales, "psa", "10")
    expect(s.scored).toBe(7)
    expect(s.medianAbsPctError).toBeLessThan(0.03)
    expect(passes(s)).toBe(true)
  })

  it("fails a card whose price jumped", () => {
    const sales = [sale(10, 100), sale(9, 100), sale(8, 100), sale(3, 300), sale(2, 310), sale(1, 305)]
    expect(passes(backtestCard(sales, "psa", "10"))).toBe(false)
  })
})

// Real log: tx 0x1c8782a0…bd25c95e, Polygon, 2026-11-22. A $28.00 USDC trade
// bought by the house buyback wallet.
const REAL: RawLog = {
  address: COURTYARD.tradeSettler,
  topics: [
    COURTYARD.tradeTopic0,
    "0x00000000000000000000000066dbff2ce099d19b4e8c5dc8b254ec7aeaf5e642",
    "0x000000000000000000000000e1fedea2389adfb35af8656f61b865aa3fd481df",
  ],
  data:
    "0x" +
    [
      "00000000000000000000000000000000000000000000000000000000000000e0",
      "0000000000000000000000000000000000000000000000000000000000000120",
      "0000000000000000000000003c499c542cef5e3811e1192ce70d8cc03d5c3359",
      "0000000000000000000000000000000000000000000000000000000001ab3f00",
      "0000000000000000000000000000000000000000000000000000000000000000",
      "0000000000000000000000000000000000000000000000000000000000000000",
      "f08213c8a2e851a5355eb0e63d713debb79a0fc6415ee270eb439905b50af6b4",
      "0000000000000000000000000000000000000000000000000000000000000001",
      "c94b6c53d04b214db7e70ceac4f68a3e0bb652f310ca690545db65bc7005508c",
      "0000000000000000000000000000000000000000000000000000000000000000",
    ].join(""),
  blockNumber: "0x5d3df00",
  transactionHash: "0x1c8782a0425900594dd91a11b824dd0f2f17890d0567b0b42c97cb31bd25c95e",
  logIndex: "0x4",
}

describe("Courtyard trade decoder", () => {
  it("decodes the real log", () => {
    const t = decodeCourtyardTrade(REAL)!
    expect(t.amountUsd).toBe(28)
    expect(t.tokenIds).toEqual(["0xc94b6c53d04b214db7e70ceac4f68a3e0bb652f310ca690545db65bc7005508c"])
    expect(t.buyer).toBe(COURTYARD.houseBuyback)
    expect(t.seller).toBe("0xe1fedea2389adfb35af8656f61b865aa3fd481df")
  })

  it("classifies house buybacks out of the comparables", () => {
    const t = decodeCourtyardTrade(REAL)!
    expect(t.kind).toBe("house")
    expect(comparablePrice(t)).toBeNull()
    const peer = decodeCourtyardTrade({
      ...REAL,
      topics: [REAL.topics[0], "0x000000000000000000000000" + "11".repeat(20), REAL.topics[2]],
    })!
    expect(peer.kind).toBe("peer")
    expect(comparablePrice(peer)).toBe(28)
  })

  it("rejects logs from other contracts or topics", () => {
    expect(decodeCourtyardTrade({ ...REAL, address: COURTYARD.registry })).toBeNull()
    expect(decodeCourtyardTrade({ ...REAL, topics: [COURTYARD.packTopic0, ...REAL.topics.slice(1)] })).toBeNull()
  })

  it("pages eth_getLogs in windows no wider than the cap", async () => {
    const spans: number[] = []
    await readCourtyardTrades(
      async (f) => {
        spans.push(parseInt(f.toBlock, 16) - parseInt(f.fromBlock, 16))
        return []
      },
      1000,
      1349,
    )
    expect(spans).toEqual([99, 99, 99, 49])
  })
})

describe("eBay Browse mappers", () => {
  it("builds a search with the affiliate context only when a campaign is set", () => {
    const plain = buildBrowseRequest({ query: "Cooper Flagg rookie" }, "T")
    expect(plain.headers["X-EBAY-C-ENDUSERCTX"]).toBeUndefined()
    expect(plain.url).toContain("category_ids=261328")
    const aff = buildBrowseRequest({ query: "Cooper Flagg", campaignId: "123", referenceId: "cooper-flagg" }, "T")
    expect(aff.headers["X-EBAY-C-ENDUSERCTX"]).toBe("affiliateCampaignId=123,affiliateReferenceId=cooper-flagg")
  })

  it("prefers the affiliate url and drops incomplete rows", () => {
    const rows = mapBrowseResponse({
      itemSummaries: [
        { itemId: "1", title: "A", price: { value: "12.50", currency: "USD" }, itemWebUrl: "u1", itemAffiliateWebUrl: "a1" },
        { itemId: "2", title: "B", price: { value: "9", currency: "GBP" }, itemWebUrl: "u2" },
        { itemId: "3", itemWebUrl: "u3" },
      ],
    })
    expect(rows.map((r) => [r.href, r.priceUsd, r.isAffiliate])).toEqual([
      ["a1", 12.5, true],
      ["u2", null, false],
    ])
  })
})

describe("cert input", () => {
  it("parses common slab inputs", () => {
    expect(parseCertInput("PSA 12345678")).toEqual({ grader: "psa", certNumber: "12345678" })
    expect(parseCertInput("beckett#0012-345-678")).toEqual({ grader: "bgs", certNumber: "0012345678" })
    expect(parseCertInput("87654321", "sgc")).toEqual({ grader: "sgc", certNumber: "87654321" })
    expect(parseCertInput("12345678")).toBeNull()
    expect(parseCertInput("PSA 12ab")).toBeNull()
  })

  it("maps an HCI cert response", () => {
    const r = mapHciCert(
      { cert: { grade: "10", player: "Cooper Flagg", year: 2025 }, card: { id: 42, name: "x" }, slab: { certVerified: true } },
      { grader: "psa", certNumber: "12345678" },
    )!
    expect(r.cardId).toBe("42")
    expect(r.certVerified).toBe(true)
    expect(mapHciCert({}, { grader: "psa", certNumber: "1" })).toBeNull()
    expect(psaLookupSucceeded({ IsValidRequest: true })).toBe(true)
  })
})

describe("box EV", () => {
  it("parses odds strings", () => {
    expect(parseOdds("1:1,200")).toBe(1200)
    expect(parseOdds("1 : 3")).toBe(3)
    expect(parseOdds("3:1")).toBeNull()
  })

  it("applies a guarantee over odds and refuses unpriced lines", () => {
    const ok = boxEv({
      packsPerBox: 24,
      boxPriceUsd: 200,
      lines: [
        { name: "Refractor", oddsPerPack: 3, valuePerHit: 2 },
        { name: "Auto", oddsPerPack: 48, guaranteedPerBox: 1, valuePerHit: 60 },
      ],
    })
    expect(ok.evUsd).toBe(76)
    expect(ok.evToPrice).toBe(0.38)
    const bad = boxEv({ packsPerBox: 24, boxPriceUsd: 200, lines: [{ name: "Auto", oddsPerPack: 24, valuePerHit: null }] })
    expect(bad.status).toBe("incomplete")
    expect(bad.unpricedLines).toEqual(["Auto"])
  })
})

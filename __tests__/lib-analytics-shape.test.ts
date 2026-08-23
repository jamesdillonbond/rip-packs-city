import { describe, it, expect } from "vitest"
import {
  buildVolumeByTier,
  aggregateMarketplaceDaily,
  buildSeriesVolumeBars,
  enrichMarketplaceRows,
  computeFmvHealth,
  computeAcquisitionBreakdown,
  bucketAcquisitionCounts,
  acquisitionMethodLabel,
} from "@/lib/analytics/shape"

describe("buildVolumeByTier", () => {
  it("returns [] for null/undefined", () => {
    expect(buildVolumeByTier(null)).toEqual([])
    expect(buildVolumeByTier(undefined)).toEqual([])
  })
  it("drops UNKNOWN and non-positive-volume tiers, rounds volume to cents", () => {
    const out = buildVolumeByTier([
      { tier: "LEGENDARY", volume: 1234.5678 },
      { tier: "UNKNOWN", volume: 999 },
      { tier: "RARE", volume: 0 },
      { tier: "", volume: 50 },
      { tier: "COMMON", volume: 10.019 },
    ])
    expect(out).toEqual([
      { name: "LEGENDARY", value: 1234.57 },
      { name: "COMMON", value: 10.02 },
    ])
  })
  it("coerces string-ish volumes via Number()", () => {
    const out = buildVolumeByTier([{ tier: "RARE", volume: "40.005" as unknown as number }])
    expect(out).toEqual([{ name: "RARE", value: 40.01 }])
  })
})

describe("aggregateMarketplaceDaily", () => {
  it("returns [] for empty/null/undefined", () => {
    expect(aggregateMarketplaceDaily(null)).toEqual([])
    expect(aggregateMarketplaceDaily(undefined)).toEqual([])
    expect(aggregateMarketplaceDaily([])).toEqual([])
  })
  it("folds per-day rows into one row per lowercased marketplace, sorted by volume desc", () => {
    const out = aggregateMarketplaceDaily([
      { marketplace: "TopShot", saleCount: 2, volume: 100 },
      { marketplace: "topshot", saleCount: 3, volume: 50.5 },
      { marketplace: "Flowty", saleCount: 1, volume: 300 },
    ])
    expect(out).toEqual([
      { marketplace: "flowty", volume: 300, transactions: 1 },
      { marketplace: "topshot", volume: 150.5, transactions: 5 },
    ])
  })
  it("maps a falsy marketplace to 'unknown' and keeps a tx-only marketplace", () => {
    const out = aggregateMarketplaceDaily([
      { marketplace: "" as unknown as string, saleCount: 4, volume: 0 },
    ])
    expect(out).toEqual([{ marketplace: "unknown", volume: 0, transactions: 4 }])
  })
  it("drops a marketplace with zero volume AND zero transactions", () => {
    const out = aggregateMarketplaceDaily([{ marketplace: "dead", saleCount: 0, volume: 0 }])
    expect(out).toEqual([])
  })
  it("rounds accumulated volume to cents", () => {
    const out = aggregateMarketplaceDaily([
      { marketplace: "x", saleCount: 1, volume: 0.1 },
      { marketplace: "x", saleCount: 1, volume: 0.2 },
    ])
    expect(out[0].volume).toBe(0.3)
  })
})

describe("buildSeriesVolumeBars", () => {
  it("returns [] for null/undefined", () => {
    expect(buildSeriesVolumeBars(null)).toEqual([])
    expect(buildSeriesVolumeBars(undefined)).toEqual([])
  })
  it("labels series, rounds volume, drops zero-volume, sorts by volume desc", () => {
    const out = buildSeriesVolumeBars([
      { series: 0, volume: 10.001, avg_price: 5, sale_count: 2 },
      { series: 4, volume: 0, avg_price: 3, sale_count: 0 },
      { series: 8, volume: 99.999, avg_price: 12, sale_count: 7 },
    ])
    // seriesLabel(0)=S1, seriesLabel(8)=25-26; series=4 dropped (0 volume)
    expect(out.map((s) => s.volume)).toEqual([100, 10])
    expect(out[0]).toMatchObject({ volume: 100, avg_price: 12, sale_count: 7 })
    expect(typeof out[0].name).toBe("string")
  })
  it("coerces non-numeric avg_price/sale_count to 0", () => {
    const out = buildSeriesVolumeBars([
      { series: 2, volume: 5, avg_price: NaN as unknown as number, sale_count: undefined as unknown as number },
    ])
    expect(out[0].avg_price).toBe(0)
    expect(out[0].sale_count).toBe(0)
  })
})

describe("enrichMarketplaceRows", () => {
  it("attaches label/color and share-of-total percentages", () => {
    const out = enrichMarketplaceRows([
      { marketplace: "topshot", volume: 75, transactions: 3 },
      { marketplace: "flowty", volume: 25, transactions: 1 },
    ])
    expect(out[0].volumePct).toBeCloseTo(75)
    expect(out[0].txPct).toBeCloseTo(75)
    expect(out[1].volumePct).toBeCloseTo(25)
    expect(out[1].txPct).toBeCloseTo(25)
    expect(typeof out[0].label).toBe("string")
    expect(typeof out[0].color).toBe("string")
  })
  it("guards divide-by-zero: all percentages are 0 when totals are 0", () => {
    const out = enrichMarketplaceRows([{ marketplace: "x", volume: 0, transactions: 0 }])
    expect(out[0].volumePct).toBe(0)
    expect(out[0].txPct).toBe(0)
  })
  it("preserves the original fields", () => {
    const out = enrichMarketplaceRows([{ marketplace: "x", volume: 10, transactions: 2 }])
    expect(out[0]).toMatchObject({ marketplace: "x", volume: 10, transactions: 2 })
  })
})

describe("computeFmvHealth", () => {
  it("sums counts and derives HIGH/LOW share", () => {
    const out = computeFmvHealth([
      { high_conf_count: 30, low_conf_count: 10, edition_count: 40, total_fmv_usd: 1000 },
      { high_conf_count: 30, low_conf_count: 30, edition_count: 60, total_fmv_usd: 500 },
    ])
    expect(out).toMatchObject({ high: 60, low: 40, edition: 100, fmv: 1500, total: 100 })
    expect(out.highPct).toBeCloseTo(60)
    expect(out.lowPct).toBeCloseTo(40)
  })
  it("returns all-zero (and 0% shares) for null/undefined/empty", () => {
    for (const arg of [null, undefined, []]) {
      const out = computeFmvHealth(arg)
      expect(out).toEqual({ high: 0, low: 0, edition: 0, fmv: 0, total: 0, highPct: 0, lowPct: 0 })
    }
  })
  it("coerces non-numeric counts to 0", () => {
    const out = computeFmvHealth([
      {
        high_conf_count: "x" as unknown as number,
        low_conf_count: 5,
        edition_count: NaN as unknown as number,
        total_fmv_usd: 100,
      },
    ])
    expect(out.high).toBe(0)
    expect(out.low).toBe(5)
    expect(out.edition).toBe(0)
    expect(out.fmv).toBe(100)
  })
})

describe("acquisition — Pinnacle trades", () => {
  it("gives `trade` its OWN bucket rather than folding it into marketplace or gift", () => {
    // ⚠ Folding a trade into `marketplace` would inflate "Marketplace Buys" with
    // acquisitions nobody paid for; folding it into `gift` would claim the
    // collector received it for nothing when they gave up Pins for it. The test
    // asserts the ABSENCE of both false claims, not merely the presence of a
    // trade count.
    const out = bucketAcquisitionCounts([{ method: "trade", count: 7 }])
    expect(out.trade).toBe(7)
    expect(out.marketplace).toBe(0)
    expect(out.gift).toBe(0)
    expect(out.pack_pull).toBe(0)
    expect(out.challenge_reward).toBe(0)
  })

  it("labels a trade \"Traded\", never \"Bought\" — the label gates cost basis", () => {
    // resolveMomentPnlBasis() treats only "Bought"/"Loan" as a cost basis. A
    // trade carries no buy_price, so a "Bought" label here would render a
    // 100%-profit moment on a Pin nobody bought.
    expect(acquisitionMethodLabel("trade")).toBe("Traded")
    expect(acquisitionMethodLabel("trade")).not.toBe("Bought")
  })

  it("counts trades in the acquisition total and its share", () => {
    const out = computeAcquisitionBreakdown({
      pack_pull_count: 25,
      marketplace_count: 25,
      challenge_reward_count: 0,
      gift_count: 0,
      trade_count: 50,
      total_tracked: 100,
    })
    expect(out.acqTotal).toBe(100)
    expect(out.pctTrade).toBeCloseTo(50)
    expect(out.pctPack).toBeCloseTo(25)
    expect(out.pctMarket).toBeCloseTo(25)
  })

  it("treats an omitted trade_count as 0 without disturbing the other shares", () => {
    // Callers built before the trade lane existed omit the field entirely; their
    // shares must be byte-identical to what they were.
    const out = computeAcquisitionBreakdown({
      pack_pull_count: 50,
      marketplace_count: 30,
      challenge_reward_count: 15,
      gift_count: 5,
      total_tracked: 100,
    })
    expect(out.acqTotal).toBe(100)
    expect(out.pctTrade).toBe(0)
    expect(out.pctPack).toBeCloseTo(50)
    expect(out.pctMarket).toBeCloseTo(30)
    expect(out.pctReward).toBeCloseTo(15)
    expect(out.pctGift).toBeCloseTo(5)
  })
})

describe("computeAcquisitionBreakdown", () => {
  it("returns zeros + not-indexed for null", () => {
    expect(computeAcquisitionBreakdown(null)).toEqual({
      acqTotal: 0,
      pctPack: 0,
      pctMarket: 0,
      pctReward: 0,
      pctGift: 0,
      pctTrade: 0,
      acquisitionNotIndexed: true,
    })
  })
  it("computes the shares against the sum", () => {
    const out = computeAcquisitionBreakdown({
      pack_pull_count: 50,
      marketplace_count: 30,
      challenge_reward_count: 15,
      gift_count: 5,
      total_tracked: 100,
    })
    expect(out.acqTotal).toBe(100)
    expect(out.pctPack).toBeCloseTo(50)
    expect(out.pctMarket).toBeCloseTo(30)
    expect(out.pctReward).toBeCloseTo(15)
    expect(out.pctGift).toBeCloseTo(5)
    expect(out.acquisitionNotIndexed).toBe(false)
  })
  it("flags not-indexed when total_tracked is 0 even with counts present", () => {
    const out = computeAcquisitionBreakdown({
      pack_pull_count: 1,
      marketplace_count: 0,
      challenge_reward_count: 0,
      gift_count: 0,
      total_tracked: 0,
    })
    expect(out.acquisitionNotIndexed).toBe(true)
  })
  it("guards divide-by-zero when every count is 0", () => {
    const out = computeAcquisitionBreakdown({
      pack_pull_count: 0,
      marketplace_count: 0,
      challenge_reward_count: 0,
      gift_count: 0,
      total_tracked: 5,
    })
    expect(out.acqTotal).toBe(0)
    expect(out.pctPack).toBe(0)
    expect(out.acquisitionNotIndexed).toBe(false)
  })
})

describe("bucketAcquisitionCounts", () => {
  it("returns all-zero for null/undefined/empty breakdown", () => {
    const zero = { pack_pull: 0, marketplace: 0, challenge_reward: 0, gift: 0, trade: 0 }
    expect(bucketAcquisitionCounts(null)).toEqual(zero)
    expect(bucketAcquisitionCounts(undefined)).toEqual(zero)
    expect(bucketAcquisitionCounts([])).toEqual(zero)
  })
  it("folds `mint` into pack_pull (the Pinnacle primary-acquisition fix)", () => {
    // Pinnacle records primary acquisitions as `mint`; before the fold it was
    // dropped and a Pinnacle wallet read "Packs Pulled: 0".
    expect(bucketAcquisitionCounts([{ method: "mint", count: 42 }])).toEqual({
      pack_pull: 42, marketplace: 0, challenge_reward: 0, gift: 0, trade: 0,
    })
  })
  it("ACCUMULATES methods that share a bucket (pack_pull + mint)", () => {
    expect(
      bucketAcquisitionCounts([
        { method: "pack_pull", count: 3 },
        { method: "mint", count: 5 },
      ]),
    ).toMatchObject({ pack_pull: 8 })
  })
  it("folds flowty_purchase and offer_accepted into marketplace", () => {
    expect(
      bucketAcquisitionCounts([
        { method: "marketplace", count: 2 },
        { method: "flowty_purchase", count: 4 },
        { method: "offer_accepted", count: 1 },
      ]),
    ).toMatchObject({ marketplace: 7 })
  })
  it("routes challenge_reward and gift to their own buckets", () => {
    expect(
      bucketAcquisitionCounts([
        { method: "challenge_reward", count: 6 },
        { method: "gift", count: 2 },
      ]),
    ).toMatchObject({ challenge_reward: 6, gift: 2 })
  })
  it("leaves loan_default / airdrop / unknown out of every bucket", () => {
    expect(
      bucketAcquisitionCounts([
        { method: "loan_default", count: 9 },
        { method: "airdrop", count: 9 },
        { method: "unknown", count: 9 },
      ]),
    ).toEqual({ pack_pull: 0, marketplace: 0, challenge_reward: 0, gift: 0, trade: 0 })
  })
  it("skips an unmapped / malformed method without throwing", () => {
    expect(bucketAcquisitionCounts([{ method: "sorcery", count: 9 }])).toEqual({
      pack_pull: 0, marketplace: 0, challenge_reward: 0, gift: 0, trade: 0,
    })
    expect(bucketAcquisitionCounts([{ count: 9 }, { method: null, count: 3 }])).toEqual({
      pack_pull: 0, marketplace: 0, challenge_reward: 0, gift: 0, trade: 0,
    })
  })
  it("does not resolve a crafted prototype-name method to a function (ownLookup guard)", () => {
    const out = bucketAcquisitionCounts([
      { method: "constructor", count: 1 },
      { method: "toString", count: 1 },
      { method: "hasOwnProperty", count: 1 },
      { method: "__proto__", count: 1 },
    ])
    expect(out).toEqual({ pack_pull: 0, marketplace: 0, challenge_reward: 0, gift: 0, trade: 0 })
  })
  it("coerces string counts and treats a malformed count as 0", () => {
    expect(
      bucketAcquisitionCounts([
        { method: "marketplace", count: "5" as unknown as number },
        { method: "mint", count: "oops" as unknown as number },
      ]),
    ).toMatchObject({ marketplace: 5, pack_pull: 0 })
  })
})

describe("acquisitionMethodLabel", () => {
  it("labels mint / flowty_purchase / offer_accepted (previously unlabeled)", () => {
    expect(acquisitionMethodLabel("mint")).toBe("Pack")
    expect(acquisitionMethodLabel("flowty_purchase")).toBe("Bought")
    expect(acquisitionMethodLabel("offer_accepted")).toBe("Bought")
  })
  it("keeps the existing labels", () => {
    expect(acquisitionMethodLabel("marketplace")).toBe("Bought")
    expect(acquisitionMethodLabel("pack_pull")).toBe("Pack")
    expect(acquisitionMethodLabel("loan_default")).toBe("Loan")
    expect(acquisitionMethodLabel("gift")).toBe("Gift")
    expect(acquisitionMethodLabel("challenge_reward")).toBe("Reward")
    expect(acquisitionMethodLabel("airdrop")).toBe("Airdrop")
  })
  it("returns null for `unknown`, null/undefined, and any unmapped method", () => {
    expect(acquisitionMethodLabel("unknown")).toBeNull()
    expect(acquisitionMethodLabel(null)).toBeNull()
    expect(acquisitionMethodLabel(undefined)).toBeNull()
    expect(acquisitionMethodLabel("sorcery")).toBeNull()
  })
  it("returns null for a crafted prototype-name method (ownLookup guard)", () => {
    expect(acquisitionMethodLabel("constructor")).toBeNull()
    expect(acquisitionMethodLabel("toString")).toBeNull()
    expect(acquisitionMethodLabel("hasOwnProperty")).toBeNull()
    expect(acquisitionMethodLabel("__proto__")).toBeNull()
  })
})

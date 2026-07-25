import { describe, it, expect } from "vitest"
import {
  buildMarketplaceMix,
  formatMixUsd,
  formatMixCount,
  sliceWidthPct,
  KNOWN_MARKETPLACES,
  OTHER_SLICE_COLOR,
  OTHER_SLICE_CLASS,
} from "@/lib/analytics-marketplace-mix-compute"

// Pins the pure bucketing/formatting logic lifted out of
// components/analytics/MarketplaceMix.tsx (invisible to the coverage ratchet).
// A regression here mis-labels or mis-sizes the stacked-bar marketplace slices
// or shows the wrong empty state.

describe("formatMixUsd", () => {
  it("returns $0 for non-positive / non-finite input", () => {
    expect(formatMixUsd(0)).toBe("$0")
    expect(formatMixUsd(-5)).toBe("$0")
    expect(formatMixUsd(Number.NaN)).toBe("$0")
    expect(formatMixUsd(Number.POSITIVE_INFINITY)).toBe("$0")
  })
  it("formats sub-thousand with no separator", () => {
    expect(formatMixUsd(1)).toBe("$1")
    expect(formatMixUsd(999)).toBe("$999")
    expect(formatMixUsd(12.7)).toBe("$13")
  })
  it("formats thousands with a k suffix and 1 decimal", () => {
    expect(formatMixUsd(1_000)).toBe("$1.0k")
    expect(formatMixUsd(12_500)).toBe("$12.5k")
    expect(formatMixUsd(999_999)).toBe("$1000.0k")
  })
  it("formats millions with an M suffix and 2 decimals", () => {
    expect(formatMixUsd(1_000_000)).toBe("$1.00M")
    expect(formatMixUsd(2_345_000)).toBe("$2.35M")
  })
})

describe("formatMixCount", () => {
  it("returns 0 for non-positive / non-finite input", () => {
    expect(formatMixCount(0)).toBe("0")
    expect(formatMixCount(-3)).toBe("0")
    expect(formatMixCount(Number.NaN)).toBe("0")
  })
  it("formats sub-thousand as a bare integer string", () => {
    expect(formatMixCount(7)).toBe("7")
    expect(formatMixCount(999)).toBe("999")
  })
  it("formats thousands with a k suffix", () => {
    expect(formatMixCount(1_000)).toBe("1.0k")
    expect(formatMixCount(48_200)).toBe("48.2k")
  })
  it("formats millions with an M suffix", () => {
    expect(formatMixCount(1_000_000)).toBe("1.00M")
    expect(formatMixCount(3_200_000)).toBe("3.20M")
  })
})

describe("sliceWidthPct", () => {
  it("returns the visible floor 0.5 when total is non-positive", () => {
    expect(sliceWidthPct(10, 0)).toBe(0.5)
    expect(sliceWidthPct(10, -1)).toBe(0.5)
  })
  it("computes a proportional percentage", () => {
    expect(sliceWidthPct(25, 100)).toBe(25)
    expect(sliceWidthPct(50, 200)).toBe(25)
  })
  it("clamps tiny slivers up to the 0.5 floor", () => {
    expect(sliceWidthPct(1, 100_000)).toBe(0.5)
    expect(sliceWidthPct(0, 100)).toBe(0.5)
  })
})

describe("buildMarketplaceMix", () => {
  it("reports empty for null/undefined/empty data", () => {
    expect(buildMarketplaceMix(null)).toEqual({ kind: "empty" })
    expect(buildMarketplaceMix(undefined)).toEqual({ kind: "empty" })
    expect(buildMarketplaceMix({})).toEqual({ kind: "empty" })
  })

  it("reports no-volume when data exists but total usd is <= 0", () => {
    expect(buildMarketplaceMix({ topshot: { count: 3, usd: 0 } })).toEqual({ kind: "no-volume" })
    // Negative usd nets to <= 0 too.
    expect(
      buildMarketplaceMix({ topshot: { count: 1, usd: -10 }, flowty: { count: 1, usd: 5 } }),
    ).toEqual({ kind: "no-volume" })
  })

  it("builds slices in KNOWN order with labels/colors/classes", () => {
    const res = buildMarketplaceMix({
      flowty: { count: 20, usd: 200 },
      topshot: { count: 50, usd: 800 },
    })
    expect(res.kind).toBe("ok")
    if (res.kind !== "ok") return
    expect(res.total).toBe(1000)
    expect(res.slices.map((s) => s.key)).toEqual(["topshot", "flowty"])
    const ts = res.slices[0]
    expect(ts.label).toBe("Top Shot marketplace")
    expect(ts.color).toBe("#10b981")
    expect(ts.className).toBe("bg-emerald-500")
    expect(ts.count).toBe(50)
    expect(ts.usd).toBe(800)
  })

  it("merges 'pinnacle' into the 'on-chain' slice (single Pinnacle-direct slice)", () => {
    const res = buildMarketplaceMix({
      "on-chain": { count: 2, usd: 100 },
      pinnacle: { count: 3, usd: 150 },
      topshot: { count: 1, usd: 250 },
    })
    expect(res.kind).toBe("ok")
    if (res.kind !== "ok") return
    const onchain = res.slices.find((s) => s.key === "on-chain")
    expect(onchain).toBeDefined()
    expect(onchain!.count).toBe(5)
    expect(onchain!.usd).toBe(250)
    // Exactly one Pinnacle-direct slice, no separate "pinnacle" key.
    expect(res.slices.filter((s) => s.label === "Pinnacle direct")).toHaveLength(1)
    expect(res.slices.some((s) => s.key === "pinnacle")).toBe(false)
  })

  it("is case-insensitive on incoming keys", () => {
    const res = buildMarketplaceMix({ TopShot: { count: 4, usd: 400 }, PINNACLE: { count: 1, usd: 100 } })
    expect(res.kind).toBe("ok")
    if (res.kind !== "ok") return
    expect(res.slices.map((s) => s.key).sort()).toEqual(["on-chain", "topshot"])
  })

  it("folds unknown sources into an 'other' slice at the end", () => {
    const res = buildMarketplaceMix({
      topshot: { count: 10, usd: 500 },
      mysterymarket: { count: 4, usd: 120 },
      anotherone: { count: 1, usd: 80 },
    })
    expect(res.kind).toBe("ok")
    if (res.kind !== "ok") return
    const other = res.slices[res.slices.length - 1]
    expect(other.key).toBe("other")
    expect(other.label).toBe("Other")
    expect(other.count).toBe(5)
    expect(other.usd).toBe(200)
    expect(other.color).toBe(OTHER_SLICE_COLOR)
    expect(other.className).toBe(OTHER_SLICE_CLASS)
    expect(res.total).toBe(700)
  })

  it("does not emit an 'other' slice when every source is known", () => {
    const res = buildMarketplaceMix({ topshot: { count: 1, usd: 100 } })
    expect(res.kind).toBe("ok")
    if (res.kind !== "ok") return
    expect(res.slices.some((s) => s.key === "other")).toBe(false)
  })

  it("coerces missing/garbage count and usd fields to 0", () => {
    // Cast through unknown because the real RPC can emit partial rows.
    const res = buildMarketplaceMix({
      topshot: { usd: 300 } as unknown as { count: number; usd: number },
      flowty: { count: 5 } as unknown as { count: number; usd: number },
    })
    expect(res.kind).toBe("ok")
    if (res.kind !== "ok") return
    const ts = res.slices.find((s) => s.key === "topshot")!
    expect(ts.count).toBe(0)
    expect(ts.usd).toBe(300)
    // flowty has usd NaN->0, so total is just topshot's 300 and flowty (usd 0)
    // still appears as a zero-volume slice.
    expect(res.total).toBe(300)
  })
})

describe("KNOWN_MARKETPLACES", () => {
  it("lists topshot, flowty, and both Pinnacle aliases", () => {
    expect(KNOWN_MARKETPLACES.map((k) => k.key)).toEqual(["topshot", "flowty", "on-chain", "pinnacle"])
  })
})

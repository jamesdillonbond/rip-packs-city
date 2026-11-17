import { describe, it, expect } from "vitest"
import {
  formatUsd,
  formatPrice,
  formatNumber,
  deltaPct,
  buildQs,
  normalizeCollectionProp,
  reshapeForVolumeChart,
  salesWindowLabel,
} from "@/lib/analytics-sales-compute"
import type { SalesTimeseriesRow } from "@/lib/analytics-types"

// Pins the pure formatting / delta / reshape / window-label logic lifted out of
// components/analytics/SalesDashboard.tsx (invisible to the coverage ratchet).
// A regression here mis-formats KPI cards, drops query params, or mis-labels windows.

describe("formatUsd", () => {
  it("returns $0 for null/undefined/non-finite/non-positive", () => {
    expect(formatUsd(null)).toBe("$0")
    expect(formatUsd(undefined)).toBe("$0")
    expect(formatUsd(Number.NaN)).toBe("$0")
    expect(formatUsd(Number.POSITIVE_INFINITY)).toBe("$0")
    expect(formatUsd(0)).toBe("$0")
    expect(formatUsd(-100)).toBe("$0")
  })
  it("abbreviates millions with 2 decimals", () => {
    expect(formatUsd(1_000_000)).toBe("$1.00M")
    expect(formatUsd(2_500_000)).toBe("$2.50M")
  })
  it("abbreviates thousands with 1 decimal", () => {
    expect(formatUsd(1_000)).toBe("$1.0k")
    expect(formatUsd(12_340)).toBe("$12.3k")
  })
  it("renders sub-thousand as whole dollars", () => {
    expect(formatUsd(999)).toBe("$999")
    expect(formatUsd(5.7)).toBe("$6")
  })
})

describe("formatPrice", () => {
  it("returns em-dash for null/undefined/non-finite/non-positive", () => {
    expect(formatPrice(null)).toBe("—")
    expect(formatPrice(undefined)).toBe("—")
    expect(formatPrice(Number.NaN)).toBe("—")
    expect(formatPrice(0)).toBe("—")
    expect(formatPrice(-5)).toBe("—")
  })
  it("abbreviates >= 10k to thousands with 1 decimal", () => {
    expect(formatPrice(10_000)).toBe("$10.0k")
    expect(formatPrice(15_500)).toBe("$15.5k")
  })
  it("renders 100..9999 as whole dollars", () => {
    expect(formatPrice(100)).toBe("$100")
    expect(formatPrice(9_999)).toBe("$9999")
  })
  it("renders under 100 with 2 decimals", () => {
    expect(formatPrice(99.99)).toBe("$99.99")
    expect(formatPrice(1)).toBe("$1.00")
  })
})

describe("formatNumber", () => {
  it("returns 0 for null/undefined/non-finite/non-positive", () => {
    expect(formatNumber(null)).toBe("0")
    expect(formatNumber(undefined)).toBe("0")
    expect(formatNumber(Number.NaN)).toBe("0")
    expect(formatNumber(0)).toBe("0")
    expect(formatNumber(-3)).toBe("0")
  })
  it("abbreviates millions and thousands", () => {
    expect(formatNumber(1_000_000)).toBe("1.00M")
    expect(formatNumber(3_400)).toBe("3.4k")
  })
  it("renders small counts verbatim", () => {
    expect(formatNumber(42)).toBe("42")
    expect(formatNumber(999)).toBe("999")
  })
})

describe("deltaPct", () => {
  it("returns null when either side is null/undefined/non-finite", () => {
    expect(deltaPct(null, 100)).toBeNull()
    expect(deltaPct(100, null)).toBeNull()
    expect(deltaPct(undefined, undefined)).toBeNull()
    expect(deltaPct(Number.NaN, 100)).toBeNull()
    expect(deltaPct(100, Number.POSITIVE_INFINITY)).toBeNull()
  })
  it("returns null when the prior period is non-positive", () => {
    expect(deltaPct(100, 0)).toBeNull()
    expect(deltaPct(100, -50)).toBeNull()
  })
  it("computes a percent change rounded to one decimal", () => {
    expect(deltaPct(150, 100)).toBe(50)
    expect(deltaPct(50, 100)).toBe(-50)
    expect(deltaPct(133, 100)).toBe(33)
    expect(deltaPct(100.5, 100)).toBe(0.5)
  })
})

describe("buildQs", () => {
  it("always sets the window and omits collections when empty", () => {
    expect(buildQs("l30", [])).toBe("window=l30")
  })
  it("joins collections with a comma", () => {
    expect(buildQs("l7", ["topshot", "allday"])).toBe("window=l7&collections=topshot%2Callday")
  })
})

describe("normalizeCollectionProp", () => {
  it("returns [] for null/undefined/empty", () => {
    expect(normalizeCollectionProp(null)).toEqual([])
    expect(normalizeCollectionProp(undefined)).toEqual([])
    expect(normalizeCollectionProp("")).toEqual([])
  })
  it("filters falsy entries from an array", () => {
    expect(normalizeCollectionProp(["topshot", "", "allday"])).toEqual(["topshot", "allday"])
  })
  it("splits a comma string, trims, and drops empties", () => {
    expect(normalizeCollectionProp("topshot, allday ,, golazos")).toEqual([
      "topshot",
      "allday",
      "golazos",
    ])
    expect(normalizeCollectionProp("solo")).toEqual(["solo"])
  })
})

describe("reshapeForVolumeChart", () => {
  it("re-keys sales rows into the loans/volume-chart shape", () => {
    const rows: SalesTimeseriesRow[] = [
      { bucket: "2026-07-01", collection: "topshot", sale_count: 12, volume_usd: 3400, avg_price_usd: 283 },
    ]
    expect(reshapeForVolumeChart(rows)).toEqual([
      {
        bucket: "2026-07-01",
        collection: "topshot",
        loan_count: 12,
        principal_usd: 3400,
        repayment_usd: 0,
      },
    ])
  })
  it("coerces non-numeric volume to 0 and maps empty input to []", () => {
    const rows = [
      { bucket: "2026-07-02", collection: "allday", sale_count: 1, volume_usd: Number.NaN, avg_price_usd: null },
    ] as unknown as SalesTimeseriesRow[]
    expect(reshapeForVolumeChart(rows)[0].principal_usd).toBe(0)
    expect(reshapeForVolumeChart([])).toEqual([])
  })
})

describe("salesWindowLabel", () => {
  it("maps each known window to its label", () => {
    expect(salesWindowLabel("l7")).toBe("Last 7 days")
    expect(salesWindowLabel("l30")).toBe("Last 30 days")
    expect(salesWindowLabel("l90")).toBe("Last 90 days")
    expect(salesWindowLabel("ytd")).toBe("Year to date")
    expect(salesWindowLabel("y2026")).toBe("2026")
    expect(salesWindowLabel("y2025")).toBe("2025")
  })
  it("falls back to All time for the catch-all window", () => {
    expect(salesWindowLabel("all")).toBe("All time")
  })
})

import { describe, it, expect } from "vitest"
import {
  formatUsd,
  formatNumber,
  formatPct,
  deltaPct,
  buildQs,
  normalizeCollectionProp,
  windowLabel,
  pickAprRate,
  ratePctRounded,
  termRatePctRounded,
  aprSublabel,
  repeatSubtitle,
  limboFreshnessLabel,
  type LoanWindow,
} from "@/lib/analytics-loans-dashboard-compute"

// Pins the pure formatting / delta / query-string / label logic lifted out of
// components/analytics/LoansDashboard.tsx (invisible to the coverage ratchet).
// A regression mis-formats loan KPIs, mis-scopes the fetch query string, or
// mislabels the window / APR / limbo captions.

describe("formatUsd", () => {
  it("$0 for null/undefined/non-finite/non-positive", () => {
    expect(formatUsd(null)).toBe("$0")
    expect(formatUsd(undefined)).toBe("$0")
    expect(formatUsd(NaN)).toBe("$0")
    expect(formatUsd(0)).toBe("$0")
    expect(formatUsd(-1)).toBe("$0")
  })
  it("M / k / whole-dollar branches", () => {
    expect(formatUsd(2_500_000)).toBe("$2.50M")
    expect(formatUsd(4_200)).toBe("$4.2k")
    expect(formatUsd(750)).toBe("$750")
  })
})

describe("formatNumber", () => {
  it("0 for null/undefined/non-finite/non-positive", () => {
    expect(formatNumber(null)).toBe("0")
    expect(formatNumber(undefined)).toBe("0")
    expect(formatNumber(NaN)).toBe("0")
    expect(formatNumber(0)).toBe("0")
    expect(formatNumber(-3)).toBe("0")
  })
  it("M / k / verbatim branches", () => {
    expect(formatNumber(1_250_000)).toBe("1.25M")
    expect(formatNumber(9_900)).toBe("9.9k")
    expect(formatNumber(88)).toBe("88")
  })
})

describe("formatPct", () => {
  it("returns fallback for null/undefined/non-finite", () => {
    expect(formatPct(null)).toBe("—")
    expect(formatPct(undefined)).toBe("—")
    expect(formatPct(NaN)).toBe("—")
    expect(formatPct(null, "n/a")).toBe("n/a")
  })
  it("formats with one decimal + percent", () => {
    expect(formatPct(12.34)).toBe("12.3%")
    expect(formatPct(0)).toBe("0.0%")
  })
})

describe("deltaPct", () => {
  it("null when either side is nullish or non-finite", () => {
    expect(deltaPct(null, 5)).toBeNull()
    expect(deltaPct(5, null)).toBeNull()
    expect(deltaPct(undefined, 5)).toBeNull()
    expect(deltaPct(NaN, 5)).toBeNull()
    expect(deltaPct(5, Infinity)).toBeNull()
  })
  it("null when baseline <= 0", () => {
    expect(deltaPct(10, 0)).toBeNull()
    expect(deltaPct(10, -4)).toBeNull()
  })
  it("computes rounded one-decimal percent change", () => {
    expect(deltaPct(150, 100)).toBe(50)
    expect(deltaPct(75, 100)).toBe(-25)
    expect(deltaPct(1015, 1000)).toBe(1.5)
  })
})

describe("buildQs", () => {
  it("window only when no collections", () => {
    expect(buildQs("l7", [])).toBe("window=l7")
  })
  it("appends comma-joined collections (encoded)", () => {
    expect(buildQs("all", ["topshot", "allday"])).toBe("window=all&collections=topshot%2Callday")
  })
})

describe("normalizeCollectionProp", () => {
  it("empty for nullish", () => {
    expect(normalizeCollectionProp(null)).toEqual([])
    expect(normalizeCollectionProp(undefined)).toEqual([])
    expect(normalizeCollectionProp("")).toEqual([])
  })
  it("filters falsy entries from an array", () => {
    expect(normalizeCollectionProp(["topshot", "", "allday"])).toEqual(["topshot", "allday"])
  })
  it("splits, trims and filters a comma string", () => {
    expect(normalizeCollectionProp(" topshot , allday ,, ")).toEqual(["topshot", "allday"])
  })
})

describe("windowLabel", () => {
  it("maps every window key", () => {
    const cases: Array<[LoanWindow, string]> = [
      ["l7", "Last 7 days"],
      ["l30", "Last 30 days"],
      ["l90", "Last 90 days"],
      ["ytd", "Year to date"],
      ["y2026", "2026"],
      ["y2025", "2025"],
      ["all", "All time"],
    ]
    for (const [w, label] of cases) expect(windowLabel(w)).toBe(label)
  })
  it("defaults unknown values to All time", () => {
    expect(windowLabel("garbage" as LoanWindow)).toBe("All time")
  })
})

describe("pickAprRate", () => {
  it("null for nullish source", () => {
    expect(pickAprRate(null)).toBeNull()
    expect(pickAprRate(undefined)).toBeNull()
  })
  it("prefers avg_apr", () => {
    expect(pickAprRate({ avg_apr: 0.2, avg_term_rate: 0.1, avg_interest_rate: 0.05 })).toBe(0.2)
  })
  it("falls back to avg_term_rate", () => {
    expect(pickAprRate({ avg_apr: null, avg_term_rate: 0.1, avg_interest_rate: 0.05 })).toBe(0.1)
  })
  it("falls back to avg_interest_rate, else null", () => {
    expect(pickAprRate({ avg_apr: null, avg_term_rate: null, avg_interest_rate: 0.05 })).toBe(0.05)
    expect(pickAprRate({ avg_apr: null, avg_term_rate: null, avg_interest_rate: null })).toBeNull()
    expect(pickAprRate({})).toBeNull()
  })
})

describe("ratePctRounded", () => {
  it("null for nullish", () => {
    expect(ratePctRounded(null)).toBeNull()
    expect(ratePctRounded(undefined)).toBeNull()
  })
  it("scales to percent, one decimal", () => {
    expect(ratePctRounded(0.1234)).toBe(12.3)
    expect(ratePctRounded(0.2)).toBe(20)
  })
})

describe("termRatePctRounded", () => {
  it("null for nullish source / no rate fields", () => {
    expect(termRatePctRounded(null)).toBeNull()
    expect(termRatePctRounded({})).toBeNull()
    expect(termRatePctRounded({ avg_term_rate: null, avg_interest_rate: null })).toBeNull()
  })
  it("prefers avg_term_rate then avg_interest_rate", () => {
    expect(termRatePctRounded({ avg_term_rate: 0.089 })).toBe(8.9)
    expect(termRatePctRounded({ avg_term_rate: null, avg_interest_rate: 0.15 })).toBe(15)
  })
})

describe("aprSublabel", () => {
  it("undefined when term rate is null", () => {
    expect(aprSublabel(null, 77)).toBeUndefined()
    expect(aprSublabel(undefined, 77)).toBeUndefined()
  })
  it("'over term' when no avg term days", () => {
    expect(aprSublabel(8.9, null)).toBe("8.9% over term")
    expect(aprSublabel(8.9, undefined)).toBe("8.9% over term")
  })
  it("includes rounded term days when present", () => {
    expect(aprSublabel(8.9, 76.6)).toBe("8.9% over 77d term")
  })
})

describe("repeatSubtitle", () => {
  it("'<pct>% returning' when repeat pct present and uniques > 0", () => {
    expect(repeatSubtitle(42.5, 100, true)).toBe("42.5% returning")
  })
  it("'<n> originators' when there is a summary but no usable repeat pct", () => {
    expect(repeatSubtitle(null, 30, true)).toBe("30 originators")
    expect(repeatSubtitle(42.5, 0, true)).toBe("0 originators") // uniques not > 0
  })
  it("undefined when there is no summary", () => {
    expect(repeatSubtitle(null, undefined, false)).toBeUndefined()
  })
})

describe("limboFreshnessLabel", () => {
  it("null when hours is nullish", () => {
    expect(limboFreshnessLabel(null)).toBeNull()
    expect(limboFreshnessLabel(undefined)).toBeNull()
  })
  it("hours label under 24h", () => {
    expect(limboFreshnessLabel(5.2)).toBe("5.2 hours since last terminal event")
  })
  it("days label at/over 24h", () => {
    expect(limboFreshnessLabel(48)).toBe("2.0 days since last terminal event")
    expect(limboFreshnessLabel(24)).toBe("1.0 days since last terminal event")
  })
})

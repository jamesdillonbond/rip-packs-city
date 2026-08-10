import { describe, it, expect } from "vitest"
import type { SetsSeriesOverviewRow } from "@/lib/analytics-types"
import {
  SET_COLLECTIONS,
  COLLECTION_LABEL,
  COLLECTION_COLOR,
  TIER_ORDER,
  TIER_LABEL,
  TIER_COLOR,
  SORT_OPTIONS,
  COVERAGE_OPTIONS,
  LIMIT_OPTIONS,
  SERIES_RANK,
  formatUsd,
  formatNumber,
  formatPct,
  clampPct,
  collectionChipLabel,
  collectionChipColor,
  tierMixTotal,
  tierMixPct,
  coveragePct,
  medianAverage,
  buildCollectionsQs,
  toggleCollection,
  buildSeriesChart,
  seriesCollectionsPresent,
  buildSeriesTableRows,
} from "@/lib/analytics-sets-dashboard-compute"

// Pins the pure logic lifted out of components/analytics/SetsDashboard.tsx
// (components/** is invisible to the coverage ratchet). Regressions here would
// mis-order the series chart, mis-aggregate the series table, or mis-format the
// USD/number/percent cells and coverage bars.

function seriesRow(over: Partial<SetsSeriesOverviewRow> = {}): SetsSeriesOverviewRow {
  return {
    collection: "topshot",
    series: 0,
    series_label: "Series 1",
    set_count: 1,
    edition_count: 10,
    edition_count_with_fmv: 5,
    median_edition_fmv: 12,
    total_series_fmv_robust: 1000,
    ...over,
  }
}

describe("constants", () => {
  it("expose the expected option/tier lists", () => {
    expect(SET_COLLECTIONS.map((c) => c.key)).toEqual([
      "topshot",
      "allday",
      "golazos",
      "pinnacle",
      "ufc",
    ])
    // Derived from the canonical ladder. uncommon + the UFC tiers were missing
    // before, and tierMixTotal sums ONLY over this list, so they were dropped
    // from both the bar and its denominator (deep-audit D23).
    expect(TIER_ORDER).toEqual([
      "common",
      "fandom",
      "uncommon",
      "rare",
      "legendary",
      "ultimate",
      "contender",
      "challenger",
      "champion",
    ])
    expect(TIER_LABEL.legendary).toBe("Legendary")
    expect(TIER_COLOR.ultimate).toBe("#F43F5E")
    expect(COLLECTION_LABEL.ufc).toBe("UFC")
    expect(COLLECTION_COLOR.topshot).toBe("#a78bfa")
    expect(SORT_OPTIONS.map((o) => o.value)).toEqual([
      "value_desc",
      "newest",
      "name_asc",
      "completion_desc",
    ])
    expect(COVERAGE_OPTIONS).toEqual([0, 50, 75, 100])
    expect(LIMIT_OPTIONS).toEqual([50, 100, 200])
    expect(SERIES_RANK["Series 2025-26"]).toBe(8)
  })

  it("labels every collection analytics_sets_directory can surface (no raw slug leak)", () => {
    // The set-detail page (/analytics/sets/[set_id]) resolves its title/meta/
    // JSON-LD/badge via COLLECTION_LABEL[data.collection] ?? data.collection, so
    // a missing key leaks the raw slug. analytics_sets_directory(NULL) returns
    // these collection keys today — every one MUST have a proper label. candy_mlb
    // is the regression: Candy went public 2026-07-31 and its 1 set is in the
    // pre-rendered top-100, but the map lacked the key and rendered "candy_mlb".
    const REACHABLE = ["topshot", "allday", "golazos", "ufc", "candy_mlb"] as const
    for (const key of REACHABLE) {
      const label = COLLECTION_LABEL[key]
      expect(label, `missing COLLECTION_LABEL[${key}]`).toBeTruthy()
      // a proper display label, never the raw underscore/lowercase slug
      expect(label).not.toBe(key)
      expect(label).not.toMatch(/_/)
    }
    expect(COLLECTION_LABEL.candy_mlb).toBe("Candy MLB")
  })
})

describe("formatUsd", () => {
  it("returns $0 for null/non-finite/non-positive", () => {
    expect(formatUsd(null)).toBe("$0")
    expect(formatUsd(undefined)).toBe("$0")
    expect(formatUsd(NaN)).toBe("$0")
    expect(formatUsd(0)).toBe("$0")
    expect(formatUsd(-5)).toBe("$0")
  })
  it("formats magnitude branches", () => {
    expect(formatUsd(2_500_000)).toBe("$2.50M")
    expect(formatUsd(1500)).toBe("$1.5k")
    expect(formatUsd(12.5)).toBe("$12.50")
    expect(formatUsd(0.5)).toBe("$0.50")
  })
})

describe("formatNumber", () => {
  it("returns 0 for null/non-finite", () => {
    expect(formatNumber(null)).toBe("0")
    expect(formatNumber(NaN)).toBe("0")
  })
  it("formats magnitude branches", () => {
    expect(formatNumber(3_000_000)).toBe("3.00M")
    expect(formatNumber(2500)).toBe("2.5k")
    expect(formatNumber(42)).toBe("42")
  })
})

describe("formatPct", () => {
  it("null/non-finite -> em-dash; digits default 0", () => {
    expect(formatPct(null)).toBe("—")
    expect(formatPct(NaN)).toBe("—")
    expect(formatPct(66.6)).toBe("67%")
    expect(formatPct(66.6, 1)).toBe("66.6%")
  })
})

describe("clampPct", () => {
  it("clamps into [0,100]", () => {
    expect(clampPct(-10)).toBe(0)
    expect(clampPct(150)).toBe(100)
    expect(clampPct(42)).toBe(42)
  })
})

describe("collectionChipLabel / collectionChipColor", () => {
  it("resolve case-insensitively with fallbacks", () => {
    expect(collectionChipLabel("TopShot")).toBe("Top Shot")
    expect(collectionChipLabel("mystery")).toBe("mystery")
    expect(collectionChipColor("ALLDAY")).toBe("#34d399")
    expect(collectionChipColor("mystery")).toBe("#a1a1aa")
  })
})

describe("tierMixTotal / tierMixPct", () => {
  it("sums only canonical tiers", () => {
    expect(
      tierMixTotal({ common: 4, rare: 2, ultimate: 1, bogus: 999 })
    ).toBe(7)
    expect(tierMixTotal({})).toBe(0)
  })
  it("computes tier share, guarding zero", () => {
    expect(tierMixPct(2, 8)).toBe(25)
    expect(tierMixPct(2, 0)).toBe(0)
  })

  it("counts All Day's uncommon tier — 630 editions used to vanish", () => {
    // Live shape from analytics_sets_summary(['allday']) on 2026-08-09. The old
    // TIER_ORDER omitted `uncommon`, so the mix totalled 5,560 against an
    // edition_count of 6,190 and the bar silently under-represented the set.
    const allday = { common: 1611, uncommon: 630, rare: 2470, legendary: 1056, ultimate: 423 }
    expect(tierMixTotal(allday)).toBe(6190)
  })

  it("counts the UFC ladder — 444 of its 446 editions used to vanish", () => {
    // Live shape from analytics_sets_summary(['ufc']). Only `fandom` was in the
    // old list, so the card's tier mix totalled 2.
    const ufc = { fandom: 2, contender: 436, challenger: 8 }
    expect(tierMixTotal(ufc)).toBe(446)
  })

  it("still ignores a non-tier key", () => {
    // Widening the ladder must not turn the sum into "add up everything".
    expect(tierMixTotal({ common: 4, bogus: 999, edition_count: 12345 })).toBe(4)
  })
})

describe("coveragePct", () => {
  it("computes coverage, guarding zero/null totals", () => {
    expect(coveragePct(5, 10)).toBe(50)
    expect(coveragePct(5, 0)).toBe(0)
    expect(coveragePct(null, null)).toBe(0)
    expect(coveragePct(null, 10)).toBe(0)
  })
})

describe("medianAverage", () => {
  it("averages accumulated medians, null when count is zero", () => {
    expect(medianAverage(30, 3)).toBe(10)
    expect(medianAverage(0, 0)).toBeNull()
  })
})

describe("buildCollectionsQs", () => {
  it("empty -> empty string; else comma-joined", () => {
    expect(buildCollectionsQs([])).toBe("")
    expect(buildCollectionsQs(["topshot", "allday"])).toBe("topshot,allday")
  })
})

describe("toggleCollection", () => {
  it("adds/removes immutably", () => {
    expect(toggleCollection(["topshot"], "allday")).toEqual(["topshot", "allday"])
    expect(toggleCollection(["topshot", "allday"], "allday")).toEqual(["topshot"])
  })
})

describe("buildSeriesChart", () => {
  it("returns empty chart for empty rows", () => {
    expect(buildSeriesChart([])).toEqual({ chartData: [], labels: [] })
  })

  it("skips rows without a series_label", () => {
    const out = buildSeriesChart([
      seriesRow({ series_label: "" }),
    ])
    expect(out.labels).toEqual([])
    expect(out.chartData).toEqual([])
  })

  it("orders real series by rank, appends Misc / Unmapped last, and sums per collection", () => {
    const rows: SetsSeriesOverviewRow[] = [
      seriesRow({ series_label: "Series 3", collection: "topshot", total_series_fmv_robust: 300 }),
      seriesRow({ series_label: "Series 1", collection: "topshot", total_series_fmv_robust: 100 }),
      seriesRow({ series_label: "Series 1", collection: "allday", total_series_fmv_robust: 40 }),
      seriesRow({ series_label: "Misc / Unmapped", collection: "topshot", total_series_fmv_robust: 5 }),
      seriesRow({ series_label: "Series 2", collection: "topshot", total_series_fmv_robust: 200 }),
    ]
    const { chartData, labels } = buildSeriesChart(rows)
    expect(labels).toEqual(["Series 1", "Series 2", "Series 3", "Misc / Unmapped"])
    const s1 = chartData.find((d) => d.series_label === "Series 1")!
    expect(s1.topshot).toBe(100)
    expect(s1.allday).toBe(40)
  })

  it("falls back to localeCompare for equal-rank (unknown) labels", () => {
    const rows: SetsSeriesOverviewRow[] = [
      seriesRow({ series_label: "Zeta Cup", collection: "golazos" }),
      seriesRow({ series_label: "Alpha Cup", collection: "golazos" }),
    ]
    const { labels } = buildSeriesChart(rows)
    expect(labels).toEqual(["Alpha Cup", "Zeta Cup"])
  })
})

describe("seriesCollectionsPresent", () => {
  it("returns the distinct collections", () => {
    const rows = [
      seriesRow({ collection: "topshot" }),
      seriesRow({ collection: "allday" }),
      seriesRow({ collection: "topshot" }),
    ]
    expect(seriesCollectionsPresent(rows)).toEqual(["topshot", "allday"])
    expect(seriesCollectionsPresent([])).toEqual([])
  })
})

describe("buildSeriesTableRows", () => {
  it("aggregates per label, honors label order, and averages only finite medians", () => {
    const rows: SetsSeriesOverviewRow[] = [
      seriesRow({
        series_label: "Series 1",
        set_count: 2,
        edition_count: 10,
        edition_count_with_fmv: 5,
        median_edition_fmv: 10,
        total_series_fmv_robust: 100,
      }),
      seriesRow({
        series_label: "Series 1",
        set_count: 3,
        edition_count: 20,
        edition_count_with_fmv: 15,
        median_edition_fmv: 30,
        total_series_fmv_robust: 200,
      }),
      seriesRow({
        series_label: "Series 2",
        set_count: 1,
        edition_count: 4,
        edition_count_with_fmv: 0,
        median_edition_fmv: null, // not counted
        total_series_fmv_robust: 0,
      }),
    ]
    const out = buildSeriesTableRows(rows, ["Series 1", "Series 2"])
    expect(out).toHaveLength(2)
    const s1 = out[0]
    expect(s1.set_count).toBe(5)
    expect(s1.edition_count).toBe(30)
    expect(s1.edition_count_with_fmv).toBe(20)
    expect(s1.total_robust).toBe(300)
    expect(s1.median_total).toBe(40)
    expect(s1.median_count).toBe(2)
    const s2 = out[1]
    expect(s2.median_count).toBe(0) // null median ignored
    expect(s2.median_total).toBe(0)
  })

  it("drops labels not present in the aggregation map (filter Boolean)", () => {
    const rows = [seriesRow({ series_label: "Series 1" })]
    const out = buildSeriesTableRows(rows, ["Series 1", "Ghost Label"])
    expect(out.map((r) => r.series_label)).toEqual(["Series 1"])
  })

  it("ignores non-finite medians (NaN/Infinity)", () => {
    const rows = [
      seriesRow({ series_label: "Series 1", median_edition_fmv: NaN }),
      seriesRow({ series_label: "Series 1", median_edition_fmv: Infinity }),
    ]
    const out = buildSeriesTableRows(rows, ["Series 1"])
    expect(out[0].median_count).toBe(0)
  })
})

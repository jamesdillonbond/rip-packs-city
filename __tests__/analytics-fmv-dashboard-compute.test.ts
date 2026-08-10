import { describe, it, expect } from "vitest"
import type {
  FmvPipelineCollectionStats,
  FmvTierPulseRow,
} from "@/lib/analytics-types"
import {
  FMV_COLLECTIONS,
  COLLECTION_LABEL,
  TOP_MOVERS_UNSUPPORTED,
  WINDOW_OPTIONS,
  MIN_FMV_OPTIONS,
  LIMIT_OPTIONS,
  TIER_ORDER,
  TIER_COLOR,
  CONFIDENCE_STYLE,
  UUID_RE,
  formatUsd,
  formatNumber,
  formatPct,
  formatChangePct,
  formatChangeUsd,
  formatMinutesAgo,
  isLinkableEditionId,
  resolveConfidenceStyle,
  buildCollectionsQs,
  toggleCollection,
  shouldHideTopMovers,
  isThinMover,
  filterHealthEntries,
  groupTierPulseByCollection,
  bucketCollectionTiers,
  tierSharePct,
  pctHighConf,
} from "@/lib/analytics-fmv-dashboard-compute"

// Pins the pure logic lifted out of components/analytics/FmvDashboard.tsx
// (components/** is invisible to the coverage ratchet). Regressions here would
// mis-format FMV/USD/percent cells, mis-bucket the tier pulse, or drop the
// Top Movers hide rule.

function tierRow(over: Partial<FmvTierPulseRow> = {}): FmvTierPulseRow {
  return {
    collection: "topshot",
    tier: "Common",
    edition_count: 10,
    total_fmv_usd: 100,
    avg_fmv_usd: 10,
    median_fmv_usd: 8,
    high_conf_count: 5,
    low_conf_count: 2,
    ...over,
  }
}

describe("constants", () => {
  it("expose the expected option lists", () => {
    expect(FMV_COLLECTIONS.map((c) => c.key)).toEqual([
      "topshot",
      "allday",
      "pinnacle",
      "golazos",
      "ufc",
    ])
    expect(WINDOW_OPTIONS.map((w) => w.value)).toEqual([1, 7, 30])
    expect(MIN_FMV_OPTIONS).toEqual([5, 25, 100, 500])
    expect(LIMIT_OPTIONS).toEqual([25, 50, 100])
    // Now derived from the canonical ladder, common-first. Uncommon (All Day,
    // Golazos) and the three UFC tiers were missing before, so those
    // collections had no tier breakdown at all.
    expect(TIER_ORDER).toEqual([
      "Common",
      "Fandom",
      "Uncommon",
      "Rare",
      "Legendary",
      "Ultimate",
      "Contender",
      "Challenger",
      "Champion",
    ])
    expect(TIER_COLOR.Other).toBe("#52525b")
    expect(COLLECTION_LABEL.ufc).toBe("UFC Strike")
    expect(TOP_MOVERS_UNSUPPORTED.has("pinnacle")).toBe(true)
    expect(TOP_MOVERS_UNSUPPORTED.has("topshot")).toBe(false)
    expect(CONFIDENCE_STYLE.HIGH.label).toBe("High")
  })
})

describe("formatUsd", () => {
  it("returns em-dash for null/undefined/non-finite", () => {
    expect(formatUsd(null)).toBe("—")
    expect(formatUsd(undefined)).toBe("—")
    expect(formatUsd(NaN)).toBe("—")
    expect(formatUsd(Infinity)).toBe("—")
  })
  it("formats across magnitude branches", () => {
    expect(formatUsd(2_500_000)).toBe("$2.50M")
    expect(formatUsd(1500)).toBe("$1.5k")
    expect(formatUsd(12.5)).toBe("$12.50")
    expect(formatUsd(0.5)).toBe("$0.50")
    expect(formatUsd(0)).toBe("$0.00")
  })
})

describe("formatNumber", () => {
  it("returns em-dash for null/non-finite", () => {
    expect(formatNumber(null)).toBe("—")
    expect(formatNumber(NaN)).toBe("—")
  })
  it("formats magnitude branches", () => {
    expect(formatNumber(3_000_000)).toBe("3.00M")
    expect(formatNumber(2500)).toBe("2.5k")
    expect(formatNumber(42)).toBe("42")
  })
})

describe("formatPct", () => {
  it("handles null and digits", () => {
    expect(formatPct(null)).toBe("—")
    expect(formatPct(NaN)).toBe("—")
    expect(formatPct(12.34)).toBe("12.3%")
    expect(formatPct(12.34, 0)).toBe("12%")
  })
})

describe("formatChangePct", () => {
  it("adds explicit + for non-negative, none for negative", () => {
    expect(formatChangePct(null)).toBe("—")
    expect(formatChangePct(NaN)).toBe("—")
    expect(formatChangePct(0)).toBe("+0.0%")
    expect(formatChangePct(5.2)).toBe("+5.2%")
    expect(formatChangePct(-3.1)).toBe("-3.1%")
  })
})

describe("formatChangeUsd", () => {
  it("null/non-finite -> em-dash", () => {
    expect(formatChangeUsd(null)).toBe("—")
    expect(formatChangeUsd(Infinity)).toBe("—")
  })
  it("signs and magnitude branches", () => {
    expect(formatChangeUsd(0)).toBe("+$0.00")
    expect(formatChangeUsd(2_000_000)).toBe("+$2.00M")
    expect(formatChangeUsd(-2_000_000)).toBe("-$2.00M")
    expect(formatChangeUsd(1500)).toBe("+$1.5k")
    expect(formatChangeUsd(-1500)).toBe("-$1.5k")
    expect(formatChangeUsd(12.5)).toBe("+$12.50")
    expect(formatChangeUsd(-12.5)).toBe("-$12.50")
  })
})

describe("formatMinutesAgo", () => {
  it("null/non-finite -> em-dash", () => {
    expect(formatMinutesAgo(null)).toBe("—")
    expect(formatMinutesAgo(NaN)).toBe("—")
  })
  it("bucketizes minutes/hours/days", () => {
    expect(formatMinutesAgo(-5)).toBe("just now") // clamped to 0 -> <1
    expect(formatMinutesAgo(0)).toBe("just now")
    expect(formatMinutesAgo(0.4)).toBe("just now")
    expect(formatMinutesAgo(5)).toBe("5 min ago")
    expect(formatMinutesAgo(59)).toBe("59 min ago")
    expect(formatMinutesAgo(60)).toBe("1h ago")
    expect(formatMinutesAgo(23 * 60)).toBe("23h ago")
    expect(formatMinutesAgo(24 * 60)).toBe("1d ago")
    expect(formatMinutesAgo(50 * 60)).toBe("2d ago")
  })
})

describe("isLinkableEditionId / UUID_RE", () => {
  it("matches real UUIDs only", () => {
    expect(isLinkableEditionId("2c9f6b1e-1234-4abc-8def-0123456789ab")).toBe(true)
    expect(isLinkableEditionId("95:100")).toBe(false)
    expect(isLinkableEditionId("")).toBe(false)
    expect(isLinkableEditionId(null)).toBe(false)
    expect(isLinkableEditionId(undefined)).toBe(false)
    expect(UUID_RE.test("2c9f6b1e-1234-4abc-8def-0123456789ab")).toBe(true)
  })
})

describe("resolveConfidenceStyle", () => {
  it("returns null for falsy value", () => {
    expect(resolveConfidenceStyle(null)).toBeNull()
    expect(resolveConfidenceStyle(undefined)).toBeNull()
  })
  it("resolves known styles", () => {
    expect(resolveConfidenceStyle("HIGH")).toBe(CONFIDENCE_STYLE.HIGH)
    expect(resolveConfidenceStyle("ASK_ONLY")).toBe(CONFIDENCE_STYLE.ASK_ONLY)
  })
  it("falls back to LOW for an unexpected value", () => {
    // @ts-expect-error probing the runtime fallback with an off-enum value
    expect(resolveConfidenceStyle("BOGUS")).toBe(CONFIDENCE_STYLE.LOW)
  })
})

describe("buildCollectionsQs", () => {
  it("empty list -> empty string", () => {
    expect(buildCollectionsQs([])).toBe("")
  })
  it("joins with comma", () => {
    expect(buildCollectionsQs(["topshot", "allday"])).toBe("topshot,allday")
  })
})

describe("toggleCollection", () => {
  it("adds when absent", () => {
    expect(toggleCollection(["topshot"], "allday")).toEqual(["topshot", "allday"])
  })
  it("removes when present", () => {
    expect(toggleCollection(["topshot", "allday"], "topshot")).toEqual(["allday"])
  })
})

describe("shouldHideTopMovers", () => {
  it("false when nothing active", () => {
    expect(shouldHideTopMovers([])).toBe(false)
  })
  it("true only when every active is unsupported", () => {
    expect(shouldHideTopMovers(["pinnacle", "golazos"])).toBe(true)
    expect(shouldHideTopMovers(["pinnacle", "topshot"])).toBe(false)
    expect(shouldHideTopMovers(["topshot"])).toBe(false)
  })
})

describe("isThinMover", () => {
  it("true only for LOW confidence + zero 7d sales", () => {
    expect(isThinMover({ current_confidence: "LOW", sales_count_7d: 0 })).toBe(true)
    expect(isThinMover({ current_confidence: "LOW", sales_count_7d: 3 })).toBe(false)
    expect(isThinMover({ current_confidence: "HIGH", sales_count_7d: 0 })).toBe(false)
  })
})

describe("filterHealthEntries", () => {
  const stats = (over: Partial<FmvPipelineCollectionStats> = {}): FmvPipelineCollectionStats => ({
    editions_total: 100,
    high_confidence: 10,
    medium_confidence: 5,
    low_confidence: 2,
    ask_only: 1,
    reliable_total_fmv_usd: 1000,
    reliable_avg_fmv_usd: 10,
    last_refresh: null,
    minutes_since_refresh: 5,
    ...over,
  })

  it("returns [] for null/undefined collections", () => {
    expect(filterHealthEntries(null, [])).toEqual([])
    expect(filterHealthEntries(undefined, [])).toEqual([])
  })
  it("no active filter keeps all known FMV collections", () => {
    const out = filterHealthEntries({ topshot: stats(), allday: stats() }, [])
    expect(out.map(([k]) => k)).toEqual(["topshot", "allday"])
  })
  it("drops unknown collections even when nothing is active", () => {
    const out = filterHealthEntries({ topshot: stats(), mystery: stats() }, [])
    expect(out.map(([k]) => k)).toEqual(["topshot"])
  })
  it("respects the active-collection selection and case-insensitive key match", () => {
    const out = filterHealthEntries(
      { TopShot: stats(), allday: stats() },
      ["allday"]
    )
    expect(out.map(([k]) => k)).toEqual(["allday"])
  })
})

describe("groupTierPulseByCollection", () => {
  it("groups by lowercase key and drops null/non-positive total FMV", () => {
    const rows = [
      tierRow({ collection: "TopShot", total_fmv_usd: 100 }),
      tierRow({ collection: "topshot", total_fmv_usd: 50 }),
      tierRow({ collection: "allday", total_fmv_usd: 0 }), // dropped
      tierRow({ collection: "allday", total_fmv_usd: null as unknown as number }), // dropped
      tierRow({ collection: "", total_fmv_usd: 10 }),
    ]
    const map = groupTierPulseByCollection(rows)
    expect(map.get("topshot")).toHaveLength(2)
    expect(map.has("allday")).toBe(false)
    expect(map.get("")).toHaveLength(1)
  })
})

describe("bucketCollectionTiers — production casing (deep-audit D23/D12)", () => {
  // ⚠ Every fixture in the block below is TitleCase ("Common"), but
  // analytics_fmv_tier_pulse returns the Postgres tier_type enum UPPERCASE
  // ("COMMON") — verified live. The old code compared the raw value against a
  // TitleCase TIER_ORDER, so in production the test matched nothing and EVERY
  // row fell into a single gray "Other" bucket. The suite stayed green because
  // the fixtures were written in a casing production never emits: a fixture
  // that cannot fail. These cases use the real shape.
  it("buckets UPPERCASE enum tiers, as the RPC actually returns them", () => {
    const rows = [
      tierRow({ tier: "COMMON", edition_count: 5980, total_fmv_usd: 100 }),
      tierRow({ tier: "LEGENDARY", edition_count: 502, total_fmv_usd: 500 }),
      tierRow({ tier: "ULTIMATE", edition_count: 71, total_fmv_usd: 900 }),
    ]
    const { visible } = bucketCollectionTiers(rows)
    expect(visible.map((v) => v.tier)).toEqual(["Common", "Legendary", "Ultimate"])
    // The bug's signature: nothing may collapse into Other.
    expect(visible.some((v) => v.tier === "Other")).toBe(false)
  })

  it("keeps UNCOMMON — All Day and Golazos have 630/215 editions of it", () => {
    const rows = [
      tierRow({ tier: "UNCOMMON", edition_count: 531, total_fmv_usd: 50 }),
      tierRow({ tier: "COMMON", edition_count: 1487, total_fmv_usd: 80 }),
    ]
    const { visible } = bucketCollectionTiers(rows)
    expect(visible.map((v) => v.tier)).toEqual(["Common", "Uncommon"])
  })

  it("keeps the UFC ladder instead of flattening it to Other", () => {
    const rows = [
      tierRow({ tier: "CONTENDER", edition_count: 460, total_fmv_usd: 10 }),
      tierRow({ tier: "CHALLENGER", edition_count: 55, total_fmv_usd: 20 }),
      tierRow({ tier: "CHAMPION", edition_count: 1, total_fmv_usd: 30 }),
    ]
    const { visible } = bucketCollectionTiers(rows)
    expect(visible.map((v) => v.tier)).toEqual(["Contender", "Challenger", "Champion"])
  })

  it("still sends a genuinely unknown tier to Other", () => {
    // The RPC really does emit "UNKNOWN" (12 Top Shot editions). Normalizing
    // case must not turn that into a fabricated tier.
    const { visible } = bucketCollectionTiers([
      tierRow({ tier: "UNKNOWN", edition_count: 12, total_fmv_usd: 5 }),
    ])
    expect(visible.map((v) => v.tier)).toEqual(["Other"])
  })

  it("every canonical tier has a color (no silent gray fallback)", () => {
    for (const t of TIER_ORDER) {
      expect(TIER_COLOR[t], `${t} has no color`).toBeTruthy()
      expect(TIER_COLOR[t]).not.toBe(TIER_COLOR.Other)
    }
  })
})

describe("bucketCollectionTiers", () => {
  it("sums into canonical tiers, orders them, and drops empty Other", () => {
    const rows = [
      tierRow({ tier: "Common", edition_count: 4, total_fmv_usd: 40, high_conf_count: 2, low_conf_count: 1 }),
      tierRow({ tier: "Common", edition_count: 6, total_fmv_usd: 60, high_conf_count: 3, low_conf_count: 1 }),
      tierRow({ tier: "Legendary", edition_count: 1, total_fmv_usd: 500, high_conf_count: 1, low_conf_count: 0 }),
    ]
    const { visible, total } = bucketCollectionTiers(rows)
    expect(visible.map((v) => v.tier)).toEqual(["Common", "Legendary"])
    const common = visible[0]
    expect(common.edition_count).toBe(10)
    expect(common.total_fmv_usd).toBe(100)
    expect(common.high_conf_count).toBe(5)
    expect(common.low_conf_count).toBe(2)
    expect(total).toBe(600)
  })
  it("buckets unknown/null tiers into Other and keeps it when non-empty", () => {
    const rows = [
      tierRow({ tier: "Weird", edition_count: 3, total_fmv_usd: 30 }),
      tierRow({ tier: null, edition_count: 2, total_fmv_usd: 20 }),
      tierRow({ tier: "Rare", edition_count: 1, total_fmv_usd: 10 }),
    ]
    const { visible, total } = bucketCollectionTiers(rows)
    // Rare comes before Other in the ordering.
    expect(visible.map((v) => v.tier)).toEqual(["Rare", "Other"])
    const other = visible.find((v) => v.tier === "Other")!
    expect(other.edition_count).toBe(5)
    expect(other.total_fmv_usd).toBe(50)
    expect(total).toBe(60)
  })
  it("empty input -> no visible, zero total", () => {
    const { visible, total } = bucketCollectionTiers([])
    expect(visible).toEqual([])
    expect(total).toBe(0)
  })
})

describe("tierSharePct", () => {
  it("computes share, guarding against zero total", () => {
    expect(tierSharePct(25, 100)).toBe(25)
    expect(tierSharePct(50, 0)).toBe(0)
  })
})

describe("pctHighConf", () => {
  it("computes percent, guarding against zero editions", () => {
    expect(pctHighConf(3, 12)).toBe(25)
    expect(pctHighConf(5, 0)).toBe(0)
  })
})

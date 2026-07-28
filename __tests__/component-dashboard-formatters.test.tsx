import { describe, it, expect } from "vitest"
import {
  formatUsd as packsUsd,
  formatNumber as packsNum,
  formatRatio as packsRatio,
  formatPct as packsPct,
} from "@/components/analytics/PacksDashboard"
import { distinctSlugLinks } from "@/components/entity/PopularOnCollection"
import {
  formatUsd as walletsUsd,
  formatNumber as walletsNum,
} from "@/components/analytics/WalletsHubOverview"

// Pins the pure display + link-shaping helpers of two otherwise-untested
// components. PacksDashboard's formatters gate the pack-analytics money display
// — and their null case is "—", NEVER a fake "$0"/"0" that reads as a real
// zero-value pack. distinctSlugLinks is the SEO internal-linking dedupe that
// feeds Googlebot into the ~24K-page entity corpus: a dedupe/slug bug either
// duplicates crawl paths or drops them.

describe("PacksDashboard formatters — null renders '—', never a fake zero", () => {
  it("formatUsd", () => {
    expect(packsUsd(null)).toBe("—")
    expect(packsUsd(undefined)).toBe("—")
    expect(packsUsd(Number.NaN)).toBe("—")
    expect(packsUsd(2_500_000)).toBe("$2.50M")
    expect(packsUsd(2500)).toBe("$2.5k")
    expect(packsUsd(4.2)).toBe("$4.20")
  })
  it("formatNumber", () => {
    expect(packsNum(null)).toBe("—")
    expect(packsNum(1_500_000)).toBe("1.50M")
    expect(packsNum(1500)).toBe("1.5k")
    expect(packsNum(42)).toBe("42")
  })
  it("formatRatio", () => {
    expect(packsRatio(null)).toBe("—")
    expect(packsRatio(3.456)).toBe("3.46x")
  })
  it("formatPct", () => {
    expect(packsPct(null)).toBe("—")
    expect(packsPct(12.34)).toBe("12.3%")
    expect(packsPct(12.34, 2)).toBe("12.34%")
  })
})

describe("WalletsHubOverview formatters", () => {
  it("formatUsd returns $0 for null/non-positive (never $NaN), bands $M/$k/$", () => {
    expect(walletsUsd(null)).toBe("$0")
    expect(walletsUsd(0)).toBe("$0")
    expect(walletsUsd(-5)).toBe("$0")
    expect(walletsUsd(2_500_000)).toBe("$2.50M")
    expect(walletsUsd(2500)).toBe("$2.5k")
    expect(walletsUsd(150)).toBe("$150")
  })
  it("formatNumber returns 0 for null (never NaN), bands M/k", () => {
    expect(walletsNum(null)).toBe("0")
    expect(walletsNum(Number.NaN)).toBe("0")
    expect(walletsNum(1_500_000)).toBe("1.50M")
    expect(walletsNum(1500)).toBe("1.5k")
    expect(walletsNum(42)).toBe("42")
  })
})

describe("distinctSlugLinks — dedupe + cap + href", () => {
  it("dedupes names that slugify identically, keeping the first label", () => {
    const links = distinctSlugLinks(["LeBron James", "lebron james", "LeBron  James"], "nba-top-shot", "player", 10)
    expect(links).toHaveLength(1)
    expect(links[0].label).toBe("LeBron James")
    expect(links[0].href).toBe("/nba-top-shot/player/lebron-james")
  })

  it("skips empty/whitespace names and caps the output", () => {
    const links = distinctSlugLinks(["", "  ", "A", "B", "C"], "nba-top-shot", "team", 2)
    expect(links).toHaveLength(2)
    expect(links.map((l) => l.label)).toEqual(["A", "B"])
  })

  it("builds the segment-scoped href for the given collection", () => {
    const links = distinctSlugLinks(["Rookie Debut"], "nfl-all-day", "set", 5)
    expect(links[0].href).toBe("/nfl-all-day/set/rookie-debut")
  })

  it("returns [] for all-empty input", () => {
    expect(distinctSlugLinks([null, undefined, ""], "nba-top-shot", "series", 5)).toEqual([])
  })
})

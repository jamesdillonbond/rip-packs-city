import { describe, it, expect } from "vitest"
import {
  buildPlayerOptions,
  buildSetOptions,
  buildRarityOptions,
  buildSeriesOptions,
  buildBatchEditionStats,
  buildPackLookup,
  getPackCount,
  nearCompleteSets,
} from "@/lib/collection/filter-options"
import type { MomentRow } from "@/lib/collection/types"

// Pins the filter-option + per-edition aggregation derivations lifted out of the
// collection page's useMemo bodies. These feed the on-page filter dropdowns and
// the owned/locked edition rollups.

function row(over: Partial<MomentRow>): MomentRow {
  return { momentId: "m", playerName: "", setName: "", ...over } as MomentRow
}

describe("buildPlayerOptions", () => {
  it("returns distinct sorted players with 'all' first", () => {
    const rows = [
      row({ playerName: "Zion Williamson" }),
      row({ playerName: "Anthony Davis" }),
      row({ playerName: "Zion Williamson" }),
      row({ playerName: "" }), // skipped
    ]
    expect(buildPlayerOptions(rows)).toEqual(["all", "Anthony Davis", "Zion Williamson"])
  })
  it("returns just 'all' for no players", () => {
    expect(buildPlayerOptions([])).toEqual(["all"])
  })
})

describe("buildSetOptions", () => {
  it("normalizes set names and dedupes", () => {
    const rows = [row({ setName: "Base Set" }), row({ setName: "Base Set" }), row({ setName: "Metallic Gold LE" })]
    const out = buildSetOptions(rows)
    expect(out[0]).toBe("all")
    expect(out).toContain("Base Set")
    // no duplicate Base Set
    expect(out.filter((x) => x === "Base Set")).toHaveLength(1)
  })
})

describe("buildRarityOptions", () => {
  it("returns distinct sorted tiers with 'all' first", () => {
    const rows = [row({ tier: "RARE" }), row({ tier: "COMMON" }), row({ tier: "RARE" }), row({ tier: undefined })]
    expect(buildRarityOptions(rows)).toEqual(["all", "COMMON", "RARE"])
  })
})

describe("buildSeriesOptions", () => {
  it("skips null series and the '—' placeholder label", () => {
    // seriesFilterLabel with no map returns the raw series string (or "—")
    const rows = [
      row({ series: "4" }),
      row({ series: "5" }),
      row({ series: undefined }), // skipped (null)
    ]
    const out = buildSeriesOptions(rows)
    expect(out[0]).toBe("all")
    expect(out.length).toBeGreaterThanOrEqual(2)
    expect(out).not.toContain("—")
  })
  it("returns just 'all' when every row lacks a series", () => {
    expect(buildSeriesOptions([row({}), row({})])).toEqual(["all"])
  })
})

describe("buildBatchEditionStats", () => {
  it("counts owned and locked per edition scope key", () => {
    const rows = [
      row({ editionKey: "e1", setName: "Base", playerName: "A", isLocked: true }),
      row({ editionKey: "e1", setName: "Base", playerName: "A", isLocked: false }),
      row({ editionKey: "e2", setName: "Base", playerName: "B", locked: true }),
    ]
    const stats = buildBatchEditionStats(rows)
    // two rows collapse to one scope key with owned 2 / locked 1
    const e1 = Array.from(stats.values()).find((v) => v.owned === 2)
    expect(e1).toEqual({ owned: 2, locked: 1 })
    const e2 = Array.from(stats.values()).find((v) => v.owned === 1)
    expect(e2).toEqual({ owned: 1, locked: 1 })
  })
  it("honors the isLocked ?? locked fallback", () => {
    const stats = buildBatchEditionStats([row({ editionKey: "x", locked: true })])
    expect(Array.from(stats.values())[0]).toEqual({ owned: 1, locked: 1 })
  })
})

describe("buildPackLookup / getPackCount", () => {
  it("sums counts across case-variant titles", () => {
    const lookup = buildPackLookup({ "Base Set Pack": 3, "base set pack": 2 })
    expect(lookup.get("base set pack")).toBe(5)
  })
  it("returns an empty map for no packs", () => {
    expect(buildPackLookup({}).size).toBe(0)
  })
  it("matches a set name by substring in either direction", () => {
    const lookup = buildPackLookup({ "2023 base set": 7 })
    expect(getPackCount(lookup, "Base Set")).toBe(7) // title includes set
  })
  it("returns 0 when the lookup is empty or nothing matches", () => {
    expect(getPackCount(new Map(), "Base Set")).toBe(0)
    expect(getPackCount(buildPackLookup({ "unrelated pack": 1 }), "Base Set")).toBe(0)
  })
})

describe("nearCompleteSets", () => {
  const sets = [
    { name: "a", missingCount: 2, completionPct: 80 },
    { name: "b", missingCount: 1, completionPct: 90 },
    { name: "c", missingCount: 3, completionPct: 40 }, // excluded (< 50%)
    { name: "d", missingCount: 4, completionPct: 95 }, // excluded (> 3 missing)
    { name: "e", missingCount: 0, completionPct: 100 }, // excluded (complete)
    { name: "f", missingCount: 3, completionPct: 55 },
    { name: "g", missingCount: 1, completionPct: 60 },
  ]
  it("keeps 1-3 missing and >= 50% complete, sorted by fewest missing, capped at 3", () => {
    const out = nearCompleteSets(sets)
    expect(out.map((s) => s.name)).toEqual(["b", "g", "a"])
  })
  it("returns [] for null/undefined input", () => {
    expect(nearCompleteSets(null)).toEqual([])
    expect(nearCompleteSets(undefined)).toEqual([])
  })
})

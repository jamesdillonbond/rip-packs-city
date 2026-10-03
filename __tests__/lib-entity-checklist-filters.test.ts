import { describe, it, expect } from "vitest"
import {
  allEditionTiles,
  checklistOwnState,
  computeFullEditionProgress,
  filterChecklistTiles,
  parseHiddenTiers,
} from "@/lib/entity/checklist-full-editions"

// Reader filters (webz, 2026-10-01) — pure helpers behind the tier and
// ownership toggles on the team checklist.

describe("allEditionTiles", () => {
  it("keeps every edition and parallel ungrouped, priced floor-else-FMV, unpriced as null (never $0)", () => {
    const tiles = allEditionTiles([
      { route_slug: "1:1", tier: "RARE", floor_usd: 10, fmv_usd: 12, owned: false },
      { route_slug: "1:1::2", tier: "RARE", floor_usd: null, fmv_usd: 4, owned: true, owned_locked: true },
      { route_slug: "1:2", tier: "COMMON", floor_usd: null, fmv_usd: null, owned: false },
      { route_slug: "1:2", tier: "COMMON", floor_usd: 1, owned: false },
    ], true)
    expect(tiles.map((t) => t.route_slug).sort()).toEqual(["1:1", "1:1::2", "1:2"])
    expect(tiles.find((t) => t.route_slug === "1:1")!.edition_cost_usd).toBe(10)
    expect(tiles.find((t) => t.route_slug === "1:1::2")!.edition_cost_usd).toBe(4)
    expect(tiles.find((t) => t.route_slug === "1:2")!.edition_cost_usd).toBeNull()
    const p = computeFullEditionProgress(tiles, true)
    expect(p).toMatchObject({ total: 3, owned: 1, locked_owned: 1, cost_to_complete_usd: 10, unpriced_missing_count: 1 })
  })

  it("without a wallet ownership is unknown (null), not false", () => {
    const [t] = allEditionTiles([{ route_slug: "1:1", owned: false }], false)
    expect(t.owned).toBeNull()
  })
})

describe("filterChecklistTiles", () => {
  const tiles = [
    { route_slug: "a", tier: "ULTIMATE", owned: false, owned_locked: false },
    { route_slug: "b", tier: "COMMON", owned: true, owned_locked: true },
    { route_slug: "c", tier: "COMMON", owned: true, owned_locked: false },
    { route_slug: "d", tier: null, owned: false, owned_locked: false },
  ]
  const slugs = (xs: { route_slug: string }[]) => xs.map((x) => x.route_slug)

  it("drops hidden tiers (a missing tier is UNKNOWN)", () => {
    expect(slugs(filterChecklistTiles(tiles, { hiddenTiers: new Set(["ULTIMATE", "UNKNOWN"]), shownStates: null, hasLocking: true }))).toEqual(["b", "c"])
  })

  it("shows only the ownership states asked for", () => {
    expect(slugs(filterChecklistTiles(tiles, { hiddenTiers: new Set(), shownStates: new Set(["missing"]), hasLocking: true }))).toEqual(["a", "d"])
    expect(slugs(filterChecklistTiles(tiles, { hiddenTiers: new Set(), shownStates: new Set(["owned"]), hasLocking: true }))).toEqual(["c"])
  })

  it("where a collection cannot lock, a locked flag reads as plain owned", () => {
    expect(checklistOwnState({ owned: true, owned_locked: true }, false)).toBe("owned")
    expect(slugs(filterChecklistTiles(tiles, { hiddenTiers: new Set(), shownStates: new Set(["owned"]), hasLocking: false }))).toEqual(["b", "c"])
  })
})

describe("parseHiddenTiers", () => {
  it("reads a JSON string array and nothing else", () => {
    expect(parseHiddenTiers('["ULTIMATE","ULTIMATE",3,""]')).toEqual(["ULTIMATE"])
    expect(parseHiddenTiers("not json")).toEqual([])
    expect(parseHiddenTiers('{"a":1}')).toEqual([])
    expect(parseHiddenTiers(null)).toEqual([])
  })
})

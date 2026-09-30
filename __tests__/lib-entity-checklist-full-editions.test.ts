import { describe, it, expect } from "vitest"
import {
  checklistHasParallels,
  computeFullEditionProgress,
  editionPrice,
  fullEditionTiles,
  isParallelKey,
  parseChecklistView,
  type ChecklistEditionRow,
} from "@/lib/entity/checklist-full-editions"

// The "Full editions" checklist view (Trevor, 2026-09-30): the checklist at the
// full-edition level — subedition parallels removed from view, each full
// edition owned and priced on its own, and an unpriced missing edition never
// counted as $0.

const row = (route_slug: string, o: Partial<ChecklistEditionRow> = {}): ChecklistEditionRow => ({
  route_slug, tier: "COMMON", fmv_usd: null, floor_usd: null, fmv_confidence: "HIGH", owned: false, owned_count: 0, owned_locked: false, ...o,
})

describe("parallel keys", () => {
  it("recognises a Top Shot subedition key and leaves a full-edition key alone", () => {
    expect(isParallelKey("10:106::3")).toBe(true)
    expect(isParallelKey("10:106")).toBe(false)
  })
  it("reports no parallels for keys without the suffix (All Day / Golazos / Pinnacle shapes)", () => {
    expect(checklistHasParallels([{ route_slug: "1" }, { route_slug: "ABUS-MAGOMEDOV-KO-1000" }, { route_slug: "aaron-judge" }])).toBe(false)
    expect(checklistHasParallels([{ route_slug: "10:106" }, { route_slug: "10:106::3" }])).toBe(true)
    expect(checklistHasParallels([])).toBe(false)
  })
})

describe("parseChecklistView", () => {
  it("?view=full is the full-edition view; anything else is all", () => {
    expect(parseChecklistView("full")).toBe("full")
    expect(parseChecklistView(null)).toBe("all")
    expect(parseChecklistView("FULL")).toBe("all")
    expect(parseChecklistView("all")).toBe("all")
  })
  it("the 09-29 ?parallels=exclude link still opens it, but an explicit view wins", () => {
    expect(parseChecklistView(null, "exclude")).toBe("full")
    expect(parseChecklistView("all", "exclude")).toBe("all")
    expect(parseChecklistView(null, "other")).toBe("all")
  })
})

describe("editionPrice", () => {
  it("uses floor, then FMV, and never invents a price", () => {
    expect(editionPrice({ floor_usd: 5, fmv_usd: 9 })).toBe(5)
    expect(editionPrice({ floor_usd: null, fmv_usd: 9 })).toBe(9)
    expect(editionPrice({ floor_usd: 0, fmv_usd: 0 })).toBeNull()
    expect(editionPrice({ floor_usd: null, fmv_usd: null })).toBeNull()
  })
})

describe("fullEditionTiles", () => {
  const editions = [
    row("1:1", { floor_usd: 10, fmv_usd: 12 }),
    row("1:1::2", { floor_usd: 4, fmv_usd: 6, owned: true, owned_count: 2, owned_locked: true }),
    row("1:1::3", { floor_usd: 30 }),
    row("1:2", { floor_usd: 20, fmv_usd: 25, owned: true, owned_count: 1 }),
    row("1:2::2", { fmv_usd: 8, fmv_confidence: "LOW" }),
    row("1:3"),
  ]

  it("removes every subedition parallel from view", () => {
    const tiles = fullEditionTiles(editions, true)
    expect(tiles.map((t) => t.route_slug).sort()).toEqual(["1:1", "1:2", "1:3"])
    expect(tiles.some((t) => isParallelKey(t.route_slug))).toBe(false)
  })

  it("owning only a PARALLEL does not check off its full edition", () => {
    const t = fullEditionTiles(editions, true).find((x) => x.route_slug === "1:1")!
    expect(t.owned).toBe(false)
    expect(t.owned_locked).toBe(false)
  })

  it("prices each full edition by its OWN floor/FMV, never a cheaper parallel's", () => {
    const t = fullEditionTiles(editions, true).find((x) => x.route_slug === "1:1")!
    expect(t.edition_cost_usd).toBe(10)
  })

  it("without a wallet, ownership is unknown (null), not false", () => {
    for (const t of fullEditionTiles(editions, false)) {
      expect(t.owned).toBeNull()
      expect(t.owned_locked).toBeNull()
    }
  })

  it("orders missing before owned, then by FMV, deterministically", () => {
    expect(fullEditionTiles(editions, true).map((t) => t.route_slug)).toEqual(["1:1", "1:3", "1:2"])
  })

  it("a duplicated row is counted once", () => {
    expect(fullEditionTiles([row("1:1"), row("1:1")], false)).toHaveLength(1)
  })
})

describe("computeFullEditionProgress", () => {
  const editions = [
    row("1:1", { floor_usd: 10, tier: "RARE" }),
    row("1:1::2", { floor_usd: 4, owned: true }),
    row("1:2", { floor_usd: 20, owned: true, owned_locked: true }),
    row("1:3", { fmv_confidence: "NO_DATA" }),
  ]

  it("counts full editions only, and an unpriced missing edition is not $0", () => {
    const p = computeFullEditionProgress(fullEditionTiles(editions, true), true)
    expect(p.total).toBe(3)
    expect(p.owned).toBe(1)
    expect(p.locked_owned).toBe(1)
    expect(p.missing_count).toBe(2)
    expect(p.cost_to_complete_usd).toBe(10)
    expect(p.unpriced_missing_count).toBe(1)
    expect(p.completion_pct).toBe(33.3)
    expect(p.stale_missing_pct).toBe(50)
    expect(p.by_tier.map((t) => t.tier)).toEqual(["RARE", "COMMON"])
  })

  it("an empty list has no completion % (not 0%)", () => {
    const p = computeFullEditionProgress([], true)
    expect(p.total).toBe(0)
    expect(p.completion_pct).toBeNull()
    expect(p.stale_missing_pct).toBeNull()
  })
})

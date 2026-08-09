import { describe, it, expect } from "vitest"
import { buildPlayerSetCards, type PlayerEditionForSets } from "@/lib/player-page-view"

// The "Sets featuring X" strip on the player/character entity page. Groups a
// player's editions by set, sums FMV, orders by FMV desc.

describe("player-page-view · buildPlayerSetCards", () => {
  it("groups by set_slug, counts, sums FMV, and orders by fmvTotal desc", () => {
    const eds: PlayerEditionForSets[] = [
      { set_slug: "base", set_name: "Base Set", fmv_usd: 10 },
      { set_slug: "base", set_name: "Base Set", fmv_usd: 5 },
      { set_slug: "rare", set_name: "Rare Set", fmv_usd: 100 },
    ]
    const cards = buildPlayerSetCards(eds)
    expect(cards).toHaveLength(2)
    // Rare Set (100) sorts ahead of Base Set (15).
    expect(cards[0]).toEqual({ setSlug: "rare", setName: "Rare Set", count: 1, fmvTotal: 100 })
    expect(cards[1]).toEqual({ setSlug: "base", setName: "Base Set", count: 2, fmvTotal: 15 })
  })

  it("treats a null/absent fmv_usd as 0 (never NaN in the total)", () => {
    const cards = buildPlayerSetCards([
      { set_slug: "s", set_name: "S", fmv_usd: null },
      { set_slug: "s", set_name: "S" }, // fmv_usd absent
      { set_slug: "s", set_name: "S", fmv_usd: 7 },
    ])
    expect(cards).toEqual([{ setSlug: "s", setName: "S", count: 3, fmvTotal: 7 }])
  })

  it("skips editions missing a set_slug or set_name (can't build a card link)", () => {
    const cards = buildPlayerSetCards([
      { set_slug: null, set_name: "Orphan", fmv_usd: 50 },
      { set_slug: "x", set_name: null, fmv_usd: 50 },
      { set_slug: "y", set_name: "Y", fmv_usd: 3 },
    ])
    expect(cards).toEqual([{ setSlug: "y", setName: "Y", count: 1, fmvTotal: 3 }])
  })

  it("returns an empty array for no editions", () => {
    expect(buildPlayerSetCards([])).toEqual([])
  })
})

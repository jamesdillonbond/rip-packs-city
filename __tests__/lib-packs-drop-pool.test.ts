import { describe, it, expect } from "vitest"
import { collectionHasDropPool } from "@/lib/packs/drop-pool"

// Pool-derived pack surfaces (simulator, Grails, EV contributors) answer only
// where pack_drop_pool has rows. Pinnacle has none (2026-10-19): its Grails grid
// read "No grail-bearing packs matched. Try lowering the filters" and its
// simulator links opened an empty pool.
describe("collectionHasDropPool", () => {
  it.each(["nba-top-shot", "nfl-all-day", "laliga-golazos"])("%s has a drop pool", (slug) => {
    expect(collectionHasDropPool(slug)).toBe(true)
  })
  it.each(["disney-pinnacle", "ufc", "panini-blockchain", "candy-mlb", "", "nba_top_shot"])("%s has none", (slug) => {
    expect(collectionHasDropPool(slug)).toBe(false)
  })
})

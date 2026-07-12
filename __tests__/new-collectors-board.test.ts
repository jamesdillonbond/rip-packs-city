import { describe, it, expect } from "vitest"
import { EMPTY_BOARD, COVERAGE_NOTE } from "@/lib/new-collectors-board"

// The New Collectors insights board. fetchNewCollectorsBoard reads four MVs
// (DB), so only the pure shared constants are unit-tested: the empty-board
// sentinel (all four sections empty, computed_at null) and the coverage-honesty
// note explaining why new-collector counts are directional.

describe("EMPTY_BOARD", () => {
  it("has every section empty and computed_at null", () => {
    expect(EMPTY_BOARD).toEqual({
      summary: [],
      spend: [],
      gateway: {},
      cohorts: [],
      computed_at: null,
    })
  })

  it("gateway is an empty object, not an array", () => {
    expect(Array.isArray(EMPTY_BOARD.gateway)).toBe(false)
    expect(Object.keys(EMPTY_BOARD.gateway)).toHaveLength(0)
  })
})

describe("COVERAGE_NOTE", () => {
  it("flags new-collector counts as lower-confidence/directional", () => {
    expect(COVERAGE_NOTE).toMatch(/directional/)
    expect(COVERAGE_NOTE).toMatch(/debiased/)
    expect(COVERAGE_NOTE).toMatch(/92%/)
  })
})

import { describe, it, expect } from "vitest"
import {
  TRIVIA,
  pickRandomTrivia,
  pickRandomByCategory,
  type BlazersTriviaItem,
} from "@/lib/blazers-trivia"

// Locks the two pure Blazers-trivia pickers. Both are random, so we assert
// membership / category invariants rather than exact items, plus the
// empty-pool -> undefined contract of pickRandomByCategory.

describe("pickRandomTrivia", () => {
  it("always returns an item that is a member of TRIVIA", () => {
    for (let i = 0; i < 200; i++) {
      expect(TRIVIA).toContain(pickRandomTrivia())
    }
  })
})

describe("pickRandomByCategory", () => {
  const categories: BlazersTriviaItem["category"][] = [
    "moment",
    "milestone",
    "quote",
    "lore",
    "person",
  ]

  it("returns an item whose category matches the requested category", () => {
    for (const cat of categories) {
      const pool = TRIVIA.filter((t) => t.category === cat)
      expect(pool.length).toBeGreaterThan(0) // sanity: every category is populated
      for (let i = 0; i < 50; i++) {
        const picked = pickRandomByCategory(cat)
        expect(picked).toBeDefined()
        expect(picked!.category).toBe(cat)
        expect(pool).toContain(picked)
      }
    }
  })

  it("returns undefined when no item has the requested category", () => {
    // "sport" is not a valid category, so the pool is empty
    expect(
      pickRandomByCategory("sport" as unknown as BlazersTriviaItem["category"])
    ).toBeUndefined()
  })
})

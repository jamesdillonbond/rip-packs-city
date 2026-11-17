import { describe, it, expect } from "vitest"
import {
  LOADING_PHRASES,
  EMPTY_STATE_PHRASES,
  pickLoading,
  pickEmpty,
} from "@/lib/schonely"

// Locks the Schonely loading/empty-state copy: the exported phrase arrays'
// exact contents, and that pickLoading/pickEmpty always return a member of the
// corresponding array (random pick — assert membership, not exact value).

describe("schonely phrase arrays", () => {
  it("LOADING_PHRASES has the exact 6 Schonely loading lines", () => {
    expect(LOADING_PHRASES).toEqual([
      "Climbing the golden ladder...",
      "Lickety brindle up the middle...",
      "Crossing the cyclops...",
      "Bingo bango bongo...",
      "Lacing up...",
      "Working the scorer's table...",
    ])
  })

  it("EMPTY_STATE_PHRASES has the exact 3 empty-state lines", () => {
    expect(EMPTY_STATE_PHRASES).toEqual([
      "No bingo, no bango, no bongo — nothing here yet.",
      "The scoreboard's still warming up.",
      "Quiet on the court for now.",
    ])
  })
})

describe("pickLoading", () => {
  it("always returns a member of LOADING_PHRASES", () => {
    for (let i = 0; i < 200; i++) {
      expect(LOADING_PHRASES).toContain(pickLoading())
    }
  })
})

describe("pickEmpty", () => {
  it("always returns a member of EMPTY_STATE_PHRASES", () => {
    for (let i = 0; i < 200; i++) {
      expect(EMPTY_STATE_PHRASES).toContain(pickEmpty())
    }
  })
})

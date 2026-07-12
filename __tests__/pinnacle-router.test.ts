import { describe, it, expect } from "vitest"
import { isPinnacle } from "@/lib/concierge/pinnacle-router"

// isPinnacle gates the concierge's Pinnacle-specific FMV path (character/set/
// variant triple join). It must be true ONLY for the disney-pinnacle url slug.

describe("isPinnacle", () => {
  it("is true only for disney-pinnacle", () => {
    expect(isPinnacle("disney-pinnacle")).toBe(true)
  })
  it("is false for other collections + nullish", () => {
    expect(isPinnacle("nba-top-shot")).toBe(false)
    expect(isPinnacle("ufc")).toBe(false)
    expect(isPinnacle(null)).toBe(false)
    expect(isPinnacle(undefined)).toBe(false)
  })
})

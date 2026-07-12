import { describe, it, expect } from "vitest"
import {
  parseStringifiedArray,
  buildPinnacleEditionKey,
  parsePinnacleEditionKey,
  pinnacleVariantRank,
  pinnacleVariantSort,
  pinnacleSerialMultiplier,
  isPinnacleSpecialSerial,
  PINNACLE_FLOWTY_BUY_URL,
} from "@/lib/pinnacle/pinnacleTypes"

// Pinnacle uses a composite edition key (royalty_code:variant:printing) — the
// CLAUDE.md footgun where joining by anything less mis-prices. Pin the
// build/parse round-trip, the Flowty trait array parser, the serial premium
// formula, and the special-serial signals.

describe("parseStringifiedArray (Flowty trait format)", () => {
  it("strips brackets and splits on commas, trimming", () => {
    expect(parseStringifiedArray("[Grogu]")).toEqual(["Grogu"])
    expect(parseStringifiedArray("[Lucasfilm Ltd., Star Wars]")).toEqual([
      "Lucasfilm Ltd.",
      "Star Wars",
    ])
  })

  it("returns empty array for empty / bracketed-empty / nullish", () => {
    expect(parseStringifiedArray("[]")).toEqual([])
    expect(parseStringifiedArray("")).toEqual([])
    expect(parseStringifiedArray(null)).toEqual([])
    expect(parseStringifiedArray(undefined)).toEqual([])
  })
})

describe("Pinnacle edition key build ↔ parse", () => {
  it("builds royalty:variant:printing", () => {
    expect(buildPinnacleEditionKey("RC1", "Golden", 3)).toBe("RC1:Golden:3")
  })

  it("defaults printing to 1", () => {
    expect(buildPinnacleEditionKey("RC1", "Standard")).toBe("RC1:Standard:1")
  })

  it("round-trips build → parse", () => {
    const key = buildPinnacleEditionKey("RC9", "Colored Enamel", 5)
    expect(parsePinnacleEditionKey(key)).toEqual({
      royaltyCode: "RC9",
      variant: "Colored Enamel",
      printing: 5,
    })
  })

  it("parse fills sane defaults for a malformed key", () => {
    expect(parsePinnacleEditionKey("RC1")).toEqual({
      royaltyCode: "RC1",
      variant: "Standard",
      printing: 1,
    })
  })
})

describe("pinnacleVariantRank / sort", () => {
  it("ranks known variants, unknown → 0", () => {
    expect(pinnacleVariantRank("Standard")).toBe(1)
    expect(pinnacleVariantRank("Limited Edition")).toBe(8)
    expect(pinnacleVariantRank("Nonexistent")).toBe(0)
  })

  it("sorts rarer variants first (descending rank)", () => {
    const sorted = ["Standard", "Golden", "Silver Sparkle"].sort(pinnacleVariantSort)
    expect(sorted).toEqual(["Golden", "Silver Sparkle", "Standard"])
  })
})

describe("pinnacleSerialMultiplier", () => {
  it("returns 1.0 for open-edition / non-serialized pins", () => {
    expect(pinnacleSerialMultiplier(5, 100, false)).toBe(1.0)
    expect(pinnacleSerialMultiplier(null, 100, true)).toBe(1.0)
    expect(pinnacleSerialMultiplier(5, null, true)).toBe(1.0)
    expect(pinnacleSerialMultiplier(5, 0, true)).toBe(1.0)
  })

  it("applies the 1 + 0.08*(1 - serial/mint) premium for serialized pins", () => {
    // serial 1 of 100 → 1 + 0.08*(0.99) = 1.0792
    expect(pinnacleSerialMultiplier(1, 100, true)).toBeCloseTo(1.0792, 4)
    // last serial (serial == mint) → no premium
    expect(pinnacleSerialMultiplier(100, 100, true)).toBeCloseTo(1.0, 4)
  })
})

describe("isPinnacleSpecialSerial", () => {
  it("flags #1, top-10, and last serials", () => {
    expect(isPinnacleSpecialSerial(1, 100)).toEqual({ isSpecial: true, signal: "#1 Serial" })
    expect(isPinnacleSpecialSerial(7, 100)).toEqual({ isSpecial: true, signal: "Top 10 Serial" })
    expect(isPinnacleSpecialSerial(100, 100)).toEqual({ isSpecial: true, signal: "Last Serial" })
  })

  it("returns not-special for ordinary + null serials", () => {
    expect(isPinnacleSpecialSerial(50, 100)).toEqual({ isSpecial: false, signal: null })
    expect(isPinnacleSpecialSerial(null, 100)).toEqual({ isSpecial: false, signal: null })
  })
})

describe("PINNACLE_FLOWTY_BUY_URL", () => {
  it("appends the listingResourceID only when provided", () => {
    expect(PINNACLE_FLOWTY_BUY_URL("42")).toBe(
      "https://www.flowty.io/asset/0xedf9df96c92f4595/Pinnacle/NFT/42"
    )
    expect(PINNACLE_FLOWTY_BUY_URL("42", "rid9")).toBe(
      "https://www.flowty.io/asset/0xedf9df96c92f4595/Pinnacle/NFT/42?listingResourceID=rid9"
    )
  })
})

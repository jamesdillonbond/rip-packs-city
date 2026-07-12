import { describe, it, expect } from "vitest"
import { tierChip, TIER_STYLE, TIER_DEFAULT } from "@/lib/tier-style"

// Locks tierChip: it upper-cases and strips the MOMENT_TIER_ prefix, looks up
// the chip style in TIER_STYLE, and returns TIER_DEFAULT (slate) for anything
// unknown.

describe("tierChip", () => {
  it("returns the mapped style for each known tier", () => {
    expect(tierChip("ULTIMATE")).toBe(TIER_STYLE.ULTIMATE)
    expect(tierChip("LEGENDARY")).toBe(TIER_STYLE.LEGENDARY)
    expect(tierChip("RARE")).toBe(TIER_STYLE.RARE)
    expect(tierChip("COMMON")).toBe(TIER_STYLE.COMMON)
  })

  it("is case-insensitive", () => {
    expect(tierChip("ultimate")).toBe(TIER_STYLE.ULTIMATE)
    expect(tierChip("Fandom")).toBe(TIER_STYLE.FANDOM)
  })

  it("strips the MOMENT_TIER_ prefix before lookup", () => {
    expect(tierChip("MOMENT_TIER_RARE")).toBe(TIER_STYLE.RARE)
    expect(tierChip("moment_tier_legendary")).toBe(TIER_STYLE.LEGENDARY)
  })

  it("returns TIER_DEFAULT for unknown or empty tiers", () => {
    expect(tierChip("CHALLENGER")).toBe(TIER_DEFAULT)
    expect(tierChip("")).toBe(TIER_DEFAULT)
    expect(tierChip("nonsense")).toBe(TIER_DEFAULT)
  })

  it("returns a well-formed ChipStyle shape", () => {
    const chip = tierChip("ULTIMATE")
    expect(chip).toHaveProperty("background")
    expect(chip).toHaveProperty("color")
    expect(chip).toHaveProperty("border")
  })
})

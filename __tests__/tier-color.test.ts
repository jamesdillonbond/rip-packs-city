// lib/tier-color — the token-safe translucent-variant helper.
//
// Exists because four surfaces built a faded tier colour by concatenating a
// 2-digit hex alpha onto the hex ("#EC4899" + "66"). That trick is invalid
// against a CSS variable — `var(--tier-ultimate)66` is dropped silently, with
// no error anywhere — so moving those palettes onto design tokens required
// replacing the concatenation, not just the colour.

import { describe, it, expect } from "vitest"
import { NEUTRAL_TIER_COLOR, tierColorAlpha } from "@/lib/tier-color"

describe("tierColorAlpha", () => {
  it("produces valid color-mix output for a CSS variable input", () => {
    expect(tierColorAlpha("var(--tier-ultimate)", 40)).toBe(
      "color-mix(in srgb, var(--tier-ultimate) 40%, transparent)",
    )
  })
  it("works for a literal colour too (no hex-concat assumption)", () => {
    expect(tierColorAlpha("#EC4899", 15)).toBe("color-mix(in srgb, #EC4899 15%, transparent)")
  })
  it("never emits the invalid `var(...)NN` concatenation form", () => {
    for (const pct of [7, 10, 15, 33, 40]) {
      const out = tierColorAlpha("var(--tier-rare)", pct)
      expect(out).not.toMatch(/var\([^)]*\)[0-9a-fA-F]{2}/)
      expect(out.startsWith("color-mix(")).toBe(true)
    }
  })
})

describe("NEUTRAL_TIER_COLOR", () => {
  it("is a token, not a hex literal (design-system rule)", () => {
    expect(NEUTRAL_TIER_COLOR).toBe("var(--rpc-text-muted)")
    expect(NEUTRAL_TIER_COLOR).not.toMatch(/#[0-9a-fA-F]{3,8}/)
  })
})

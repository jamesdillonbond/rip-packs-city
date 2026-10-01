import { describe, it, expect } from "vitest"
import { specialSerialStyle } from "@/lib/badges/official-art"
import { GOLD_HEX } from "@/lib/badges/glyphs"

// Trevor, 2026-09-30: special serials wear each platform's NATIVE colour.
// Top Shot / All Day values sampled live from their own moment pages.
describe("specialSerialStyle", () => {
  it("Top Shot resolves to its blue by slug AND by collection UUID", () => {
    for (const c of ["nba_top_shot", "95f28a17-224a-4025-96ad-adf8a4c63bfd"]) {
      const s = specialSerialStyle(c)
      expect(s.chipBg, c).toBe("#2752ED")
      expect(s.markFg, c).toBe("#FFFFFF")
      expect(s.accentOnDark, c).toBe("#5677F1")
    }
  })

  it("All Day resolves to its purple ring on the dark card, by slug AND UUID", () => {
    for (const c of ["nfl_all_day", "dee28451-5d62-409e-a1ad-a83f763ac070"]) {
      const s = specialSerialStyle(c)
      expect(s.markBg, c).toBe("#212127")
      expect(s.markBorder, c).toBe("#7A4DE1")
      expect(s.accentOnDark, c).toBe("#7A4DE1")
    }
  })

  it("every collection without a platform special-serial badge keeps RPC gold", () => {
    for (const c of ["laliga_golazos", "disney_pinnacle", "ufc_strike", "panini_blockchain", "candy_mlb", null, undefined, ""]) {
      const s = specialSerialStyle(c)
      expect(s.chipBg, String(c)).toBe(GOLD_HEX)
      expect(s.accentOnDark, String(c)).toBe(GOLD_HEX)
    }
  })
})

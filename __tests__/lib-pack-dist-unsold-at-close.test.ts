import { describe, it, expect } from "vitest"
import { unsoldAtCloseLabel } from "@/lib/pack-dist/unsold-at-close"

// Golazos "Packs remaining" is primary_available_supply. After the sale window
// closes it is unsold inventory, not packs in collectors' hands (dist 219:
// 20,566 of 24,000, closed 2023-09-30, 1,685 opens on record).
const NOW = Date.parse("2026-10-19T12:00:00Z")
const META_219 = { primary_end_time: "2023-09-30T19:00:00Z", primary_available_supply: 20566, primary_total_supply: 24000 }

describe("unsoldAtCloseLabel", () => {
  it("names unsold supply from a CLOSED Golazos sale", () => {
    expect(unsoldAtCloseLabel("laliga-golazos", META_219, 20566, NOW)).toBe("unsold of 24,000 when the drop closed 2023-09-30")
  })
  it("says nothing while the sale is still open (it IS the remaining stock)", () => {
    expect(unsoldAtCloseLabel("laliga-golazos", { ...META_219, primary_end_time: "2123-09-30T19:00:00Z" }, 20566, NOW)).toBeNull()
  })
  it("says nothing when the tile's number is not the primary supply", () => {
    expect(unsoldAtCloseLabel("laliga-golazos", META_219, 31, NOW)).toBeNull()
    expect(unsoldAtCloseLabel("laliga-golazos", META_219, null, NOW)).toBeNull()
  })
  it("says nothing for a sold-out drop or a missing/garbled end time", () => {
    expect(unsoldAtCloseLabel("laliga-golazos", { ...META_219, primary_available_supply: 0 }, 0, NOW)).toBeNull()
    expect(unsoldAtCloseLabel("laliga-golazos", { ...META_219, primary_end_time: "soon" }, 20566, NOW)).toBeNull()
  })
  it("is Golazos-only (other collections' counters mean other things)", () => {
    expect(unsoldAtCloseLabel("nba-top-shot", META_219, 20566, NOW)).toBeNull()
  })
})

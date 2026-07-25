import { describe, it, expect } from "vitest"
import {
  serialSignalTag,
  shouldRenderSerialBadge,
  serialBadgeLabel,
} from "@/lib/sniper-serial-badge"

// Pins the pure visibility/tag/label logic lifted out of
// components/sniper/SerialBadge.tsx (invisible to the coverage ratchet). A
// regression here shows the wrong special-serial glyph, renders the pill when
// it should be hidden, or mislabels the multiplier.

describe("serialSignalTag", () => {
  it("maps the #1 / jersey / last vocabularies (case-insensitive)", () => {
    expect(serialSignalTag("#1")).toBe("#1")
    expect(serialSignalTag("#1 Mint")).toBe("#1")
    expect(serialSignalTag("Jersey #12")).toBe("jersey")
    expect(serialSignalTag("jersey serial")).toBe("jersey")
    expect(serialSignalTag("Last #499")).toBe("last_mint")
    expect(serialSignalTag("LAST MINT")).toBe("last_mint")
  })
  it("returns null for unrecognized, empty, null, or undefined signals", () => {
    expect(serialSignalTag("Perfect Mint")).toBeNull()
    expect(serialSignalTag("")).toBeNull()
    expect(serialSignalTag(null)).toBeNull()
    expect(serialSignalTag(undefined)).toBeNull()
  })
})

describe("shouldRenderSerialBadge", () => {
  it("renders when the deal is a special serial", () => {
    expect(shouldRenderSerialBadge({ isSpecialSerial: true, serialMult: 1 })).toBe(true)
    expect(shouldRenderSerialBadge({ isSpecialSerial: true, serialMult: 0.5 })).toBe(true)
  })
  it("renders when the serial multiplier is above 1", () => {
    expect(shouldRenderSerialBadge({ isSpecialSerial: false, serialMult: 1.5 })).toBe(true)
  })
  it("hidden for a plain deal (not special, multiplier <= 1)", () => {
    expect(shouldRenderSerialBadge({ isSpecialSerial: false, serialMult: 1 })).toBe(false)
    expect(shouldRenderSerialBadge({ isSpecialSerial: false, serialMult: 0 })).toBe(false)
  })
})

describe("serialBadgeLabel", () => {
  it("uses the human serialSignal when present", () => {
    expect(serialBadgeLabel({ serialSignal: "Jersey #23", serialMult: 3 })).toBe("Jersey #23")
  })
  it("falls back to the ×N.N multiplier when there is no signal", () => {
    expect(serialBadgeLabel({ serialSignal: null, serialMult: 2 })).toBe("×2.0")
    expect(serialBadgeLabel({ serialSignal: null, serialMult: 1.25 })).toBe("×1.3")
  })
})

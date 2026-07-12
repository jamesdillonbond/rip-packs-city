import { describe, it, expect } from "vitest"
import { truncateAddress, displayName } from "@/lib/flowty-username"

// Address display fallback used across every server surface that renders a
// buyer/seller when no @handle resolves (Top Sales, share cards, concierge).
// Pin the truncation shape + the name-or-truncate precedence.

describe("truncateAddress", () => {
  it("truncates a full Flow address to 0xABCD…WXYZ, lower-cased", () => {
    expect(truncateAddress("0xBD94CADE097E50AC")).toBe("0xbd94…50ac")
  })

  it("returns non-0x input unchanged (lower-cased)", () => {
    expect(truncateAddress("Trevor")).toBe("trevor")
  })

  it("leaves short 0x values untouched (<= 10 chars)", () => {
    expect(truncateAddress("0x1234")).toBe("0x1234")
    expect(truncateAddress("0x12345678")).toBe("0x12345678")
  })

  it("handles empty / falsy input", () => {
    expect(truncateAddress("")).toBe("")
  })
})

describe("displayName", () => {
  const names = new Map<string, string>([["0xbd94cade097e50ac", "jamesdillonbond"]])

  it("returns the resolved name (case-insensitive on the address key)", () => {
    expect(displayName("0xBD94CADE097E50AC", names)).toBe("jamesdillonbond")
  })

  it("falls back to a truncated address when no name is mapped", () => {
    expect(displayName("0xa3d67b29e104e701", names)).toBe("0xa3d6…e701")
  })
})

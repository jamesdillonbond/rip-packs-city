import { describe, it, expect } from "vitest"
import { truncateAddress, displayName } from "@/lib/analytics/username-resolver"

// lib/analytics/username-resolver.ts — pure display helpers only. The
// useResolveUsernames hook (fetch + React state) is out of scope. truncateAddress
// lowercases, shortens long 0x addresses to head…tail, and passes short/non-0x
// strings through. displayName prefers a resolved name (case-insensitive lookup)
// and falls back to truncateAddress.

describe("truncateAddress", () => {
  it("shortens a full 0x Flow address to head…tail, lowercased", () => {
    // slice(0,6) + '…' + slice(-4) on the lowercased address
    expect(truncateAddress("0xBD94CADE097E50AC")).toBe("0xbd94…50ac")
  })

  it("returns '' for empty input (no 0x prefix)", () => {
    expect(truncateAddress("")).toBe("")
  })

  it("lowercases and passes through a non-0x string unchanged otherwise", () => {
    expect(truncateAddress("Trevor")).toBe("trevor")
  })

  it("passes short 0x strings (length <= 10) through lowercased", () => {
    expect(truncateAddress("0x123456")).toBe("0x123456")
    expect(truncateAddress("0x12345678")).toBe("0x12345678") // exactly length 10
  })

  it("truncates once length exceeds 10", () => {
    expect(truncateAddress("0x123456789A")).toBe("0x1234…789a")
  })
})

describe("displayName", () => {
  const names = { "0xbd94cade097e50ac": "jamesdillonbond" }

  it("returns the resolved username via case-insensitive lookup", () => {
    expect(displayName("0xBD94CADE097E50AC", names)).toBe("jamesdillonbond")
  })

  it("falls back to the truncated address when unknown", () => {
    expect(displayName("0xA3D67B29E104E701", names)).toBe("0xa3d6…e701")
  })

  it("returns '' for empty address with no match", () => {
    expect(displayName("", names)).toBe("")
  })
})

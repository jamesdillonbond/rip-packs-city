import { describe, it, expect } from "vitest"
import { isWalletAddress } from "@/lib/chains/flow/topshot-username-resolve"

// Top Shot username -> wallet resolver. The resolver fns hit GQL/DB, so only the
// pure Flow-address validator is unit-tested: it accepts a 16-hex 0x address
// (trimming surrounding whitespace) and rejects usernames / malformed strings.

describe("isWalletAddress", () => {
  it("accepts a canonical 16-hex 0x Flow address", () => {
    expect(isWalletAddress("0xbd94cade097e50ac")).toBe(true)
    expect(isWalletAddress("0xBD94CADE097E50AC")).toBe(true)
  })

  it("trims surrounding whitespace before matching", () => {
    expect(isWalletAddress("  0xbd94cade097e50ac  ")).toBe(true)
  })

  it("rejects usernames and non-address strings", () => {
    expect(isWalletAddress("jamesdillonbond")).toBe(false)
    expect(isWalletAddress("@tdillonbond")).toBe(false)
    expect(isWalletAddress("")).toBe(false)
  })

  it("rejects wrong-length or non-hex 0x strings", () => {
    expect(isWalletAddress("0xbd94cade097e50")).toBe(false) // 14 hex
    expect(isWalletAddress("0xbd94cade097e50abc")).toBe(false) // 18 hex
    expect(isWalletAddress("0xbd94cade097e50zz")).toBe(false) // non-hex
    expect(isWalletAddress("bd94cade097e50ac")).toBe(false) // missing 0x
  })
})

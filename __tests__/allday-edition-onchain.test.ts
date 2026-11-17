import { describe, it, expect } from "vitest"
import { normalizeAddress } from "@/lib/chains/flow/allday-edition-onchain"

// lib/chains/flow/allday-edition-onchain.ts normalizeAddress zero-pads Flow
// addresses to the canonical 16-hex 0x form. Unlike the offer-fill normAddr it
// PADS (Flow event addresses can arrive short), so a wallet key stays stable
// across the indexer, wmc, and sales joins. Previously untested.

describe("normalizeAddress", () => {
  it("zero-pads a short address to 16 hex digits", () => {
    expect(normalizeAddress("0xabc")).toBe("0x0000000000000abc")
  })
  it("leaves a full 16-hex address unchanged (lowercased)", () => {
    expect(normalizeAddress("0xBD94CADE097E50AC")).toBe("0xbd94cade097e50ac")
  })
  it("adds the 0x prefix when absent", () => {
    expect(normalizeAddress("bd94cade097e50ac")).toBe("0xbd94cade097e50ac")
  })
  it("trims surrounding whitespace", () => {
    expect(normalizeAddress("  0xAbC  ")).toBe("0x0000000000000abc")
  })
})

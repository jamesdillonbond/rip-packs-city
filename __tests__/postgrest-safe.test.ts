import { describe, it, expect } from "vitest"
import { sanitizeOrIlikeValue, isFlowAddress } from "@/lib/postgrest-safe"

describe("sanitizeOrIlikeValue", () => {
  it("passes through a clean value unchanged", () => {
    expect(sanitizeOrIlikeValue("LeBron James")).toBe("LeBron James")
    expect(sanitizeOrIlikeValue("O'Neal")).toBe("O'Neal") // apostrophe is not a filter metachar
  })

  it("leaves dots intact (legal inside a filter value)", () => {
    expect(sanitizeOrIlikeValue("A.J. Green")).toBe("A.J. Green")
  })

  it("neutralizes the comma column-pivot breakout", () => {
    // Without sanitization this would terminate the ilike term and inject a new
    // OR condition against another column.
    const evil = "a,collection_id.eq.00000000-0000-0000-0000-000000000000,b"
    const out = sanitizeOrIlikeValue(evil)
    expect(out).not.toContain(",")
    expect(out).toBe("a collection_id.eq.00000000-0000-0000-0000-000000000000 b")
  })

  it("neutralizes paren group-injection and wildcard chars", () => {
    expect(sanitizeOrIlikeValue("foo)")).toBe("foo ")
    expect(sanitizeOrIlikeValue("(and(x.eq.1))")).toBe(" and x.eq.1  ")
    expect(sanitizeOrIlikeValue("%bar%")).toBe(" bar ")
  })
})

describe("isFlowAddress", () => {
  it("accepts a canonical 0x + 16 hex address (either case)", () => {
    expect(isFlowAddress("0xbd94cade097e50ac")).toBe(true)
    expect(isFlowAddress("0xBD94CADE097E50AC")).toBe(true)
  })

  it("rejects wrong length, missing prefix, and non-hex", () => {
    expect(isFlowAddress("0xbd94cade097e50a")).toBe(false) // 15 hex
    expect(isFlowAddress("0xbd94cade097e50acd")).toBe(false) // 17 hex
    expect(isFlowAddress("bd94cade097e50ac")).toBe(false) // no 0x
    expect(isFlowAddress("0xzz94cade097e50ac")).toBe(false) // non-hex
  })

  it("rejects a value carrying a filter-grammar breakout", () => {
    // The exact class the .in.(...) / .eq. interpolation guards against.
    expect(isFlowAddress("0xAA,tier.eq.LEGEN")).toBe(false)
    expect(isFlowAddress("0xAA),and(x.eq.1")).toBe(false)
  })
})

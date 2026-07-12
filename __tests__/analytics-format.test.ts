import { describe, it, expect } from "vitest"
import { fmtUsd, fmt, shortAddr, relativeDate } from "@/lib/analytics/format"

// Shared analytics formatters. Pure except relativeDate (Date.now); pin the
// deterministic money/address formatting + relativeDate's invalid-date guard.

describe("fmtUsd", () => {
  it("formats a 2-decimal USD string, nullish → $0.00", () => {
    expect(fmtUsd(1234.5)).toBe("$1,234.50")
    expect(fmtUsd(0)).toBe("$0.00")
    // @ts-expect-error — guarding the runtime Number(x)||0 path
    expect(fmtUsd(null)).toBe("$0.00")
  })
})

describe("fmt (compact money)", () => {
  it("abbreviates millions and thousands", () => {
    expect(fmt(2_500_000)).toBe("$2.5M")
    expect(fmt(1_500)).toBe("$1.5k")
    expect(fmt(42)).toBe("$42.00")
  })
})

describe("shortAddr", () => {
  it("truncates long addresses, passes short/empty through", () => {
    expect(shortAddr("0xbd94cade097e50ac")).toBe("0xbd94…50ac")
    expect(shortAddr("0x1234")).toBe("0x1234")
    expect(shortAddr("")).toBe("—")
  })
})

describe("relativeDate", () => {
  it("returns '' for an invalid date", () => {
    expect(relativeDate("not-a-date")).toBe("")
  })
  it("returns an ISO day for dates older than 30 days", () => {
    expect(relativeDate("2020-01-15T00:00:00Z")).toBe("2020-01-15")
  })
})

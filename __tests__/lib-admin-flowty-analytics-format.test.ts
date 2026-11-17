import { describe, it, expect } from "vitest"
import { fmtCurrency, fmtInt, fmtPct, truncAddr, pivot, pickSalesActor, getStr, getNum } from "@/lib/admin/flowty-analytics-format"

describe("flowty-analytics-format — fmtCurrency", () => {
  it("em-dash for null/NaN", () => {
    expect(fmtCurrency(null)).toBe("—")
    expect(fmtCurrency(NaN)).toBe("—")
  })
  it("whole dollars at/above $1,000, 2 decimals below", () => {
    expect(fmtCurrency(2500.7)).toBe("$2,501")
    expect(fmtCurrency(12.5)).toBe("$12.50")
    expect(fmtCurrency(999.99)).toBe("$999.99")
  })
})

describe("flowty-analytics-format — fmtInt / truncAddr", () => {
  it("fmtInt rounds+groups, em-dash for null/NaN", () => {
    expect(fmtInt(1234.4)).toBe("1,234")
    expect(fmtInt(null)).toBe("—")
  })
  it("truncAddr middle-ellipsizes over 14 chars", () => {
    expect(truncAddr("0x1234567890abcd")).toBe("0x1234…abcd")
    expect(truncAddr("short")).toBe("short")
    expect(truncAddr(null)).toBe("—")
  })
})

describe("flowty-analytics-format — fmtPct", () => {
  it("treats |n| <= 1 as a decimal (scales ×100), otherwise as already-percent", () => {
    expect(fmtPct(0.125)).toBe("12.50%")
    expect(fmtPct(12.5)).toBe("12.50%")
    expect(fmtPct(1)).toBe("100.00%")
    expect(fmtPct(null)).toBe("—")
  })
})

describe("flowty-analytics-format — pivot", () => {
  const rows = [
    { bucket: "2026-06-02", collection: "topshot", volume: 10 },
    { bucket: "2026-06-01", collection: "topshot", volume: 5 },
    { bucket: "2026-06-01", collection: "topshot", volume: 3 }, // sums with above
    { bucket: "2026-06-01", collection: "allday", volume: 7 },
    { bucket: "2026-06-01", collection: "ignored", volume: 99 }, // not in collections
  ]
  it("pivots long→wide, sums per (bucket,collection), sorts by bucket, 0-fills", () => {
    const out = pivot(rows, "volume", ["topshot", "allday"])
    expect(out).toEqual([
      { bucket: "2026-06-01", topshot: 8, allday: 7 },
      { bucket: "2026-06-02", topshot: 10, allday: 0 },
    ])
  })
  it("drops collections not in the requested set", () => {
    const out = pivot(rows, "volume", ["topshot"])
    expect(out.every((r) => !("ignored" in r) && !("allday" in r))).toBe(true)
  })
})

describe("flowty-analytics-format — pickSalesActor", () => {
  it("prefers distinct*, falls back to active*, then 0", () => {
    expect(pickSalesActor({ distinctBuyers: 5, activeBuyers: 9 }, "buyers")).toBe(5)
    expect(pickSalesActor({ activeBuyers: 9 }, "buyers")).toBe(9)
    expect(pickSalesActor({}, "buyers")).toBe(0)
    expect(pickSalesActor({ distinctSellers: 4 }, "sellers")).toBe(4)
    expect(pickSalesActor({ activeSellers: 2 }, "sellers")).toBe(2)
  })
})

describe("flowty-analytics-format — getStr", () => {
  it("returns a string value, null otherwise", () => {
    expect(getStr("hi")).toBe("hi")
    expect(getStr("")).toBe("")
    expect(getStr(5)).toBeNull()
    expect(getStr(null)).toBeNull()
    expect(getStr(undefined)).toBeNull()
    expect(getStr({})).toBeNull()
  })
})

describe("flowty-analytics-format — getNum", () => {
  it("passes through finite numbers", () => {
    expect(getNum(5)).toBe(5)
    expect(getNum(0)).toBe(0)
    expect(getNum(-2.5)).toBe(-2.5)
  })
  it("coerces numeric strings", () => {
    expect(getNum("42")).toBe(42)
    expect(getNum("3.14")).toBeCloseTo(3.14)
  })
  it("returns null for null/undefined", () => {
    expect(getNum(null)).toBeNull()
    expect(getNum(undefined)).toBeNull()
  })
  it("returns null for non-numeric / NaN", () => {
    expect(getNum("abc")).toBeNull()
    expect(getNum(NaN)).toBeNull()
    expect(getNum({})).toBeNull()
  })
})

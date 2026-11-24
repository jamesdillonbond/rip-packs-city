import { describe, it, expect } from "vitest"
import { fmtListedPct } from "@/lib/insights/pinnacle-board-format"

describe("fmtListedPct — a listed pin never prints as 0%", () => {
  it("prints <0.1% when copies are listed but the rounded share is 0", () => {
    expect(fmtListedPct(0, 3)).toBe("<0.1%")
    expect(fmtListedPct(0.05, 1)).toBe("<0.1%")
  })
  it("prints 0% only for a true zero", () => {
    expect(fmtListedPct(0, 0)).toBe("0%")
  })
  it("prints the share otherwise and a dash when unknown", () => {
    expect(fmtListedPct(1.4, 12)).toBe("1.4%")
    expect(fmtListedPct(null, 3)).toBe("—")
    expect(fmtListedPct(Number.NaN, 3)).toBe("—")
  })
})

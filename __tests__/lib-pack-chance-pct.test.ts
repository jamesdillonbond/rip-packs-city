import { describe, it, expect } from "vitest"
import { fmtChancePct } from "@/lib/pack-chance-pct"

describe("fmtChancePct", () => {
  it("never renders a real, tiny pull chance as 0.00%", () => {
    expect(fmtChancePct(0.00003)).toBe("<0.01%")
    expect(fmtChancePct(0.00003)).not.toBe("0.00%")
  })
  it("keeps two decimals otherwise, and a true zero reads 0.00%", () => {
    expect(fmtChancePct(0.0123)).toBe("1.23%")
    expect(fmtChancePct(0.0001)).toBe("0.01%")
    expect(fmtChancePct(0)).toBe("0.00%")
  })
})

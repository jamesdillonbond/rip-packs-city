import { describe, it, expect } from "vitest"
import { fmtDate, fmtDollars } from "@/components/profile/_shared"

// Pure profile-card formatters (invisible to the component coverage ratchet
// when imported by a .test.ts). fmtDate feeds the PortfolioSparkline axis;
// fmtDollars feeds the profile Cost-Basis / Top-Movers cards.

describe("fmtDate", () => {
  it("renders M/D from the UTC components of a date-only string", () => {
    // A date-only 'YYYY-MM-DD' parses as UTC midnight. Using the local
    // getMonth()/getDate() rendered the day BEFORE for any viewer west of UTC
    // (all of the Americas) — every sparkline axis label was off by one.
    expect(fmtDate("2026-04-15")).toBe("4/15")
    expect(fmtDate("2026-01-01")).toBe("1/1")
    expect(fmtDate("2026-12-31")).toBe("12/31")
  })
})

describe("fmtDollars", () => {
  it("uses the $XK form at/above 1000, cents below", () => {
    expect(fmtDollars(2500)).toBe("$2.5K")
    expect(fmtDollars(42)).toBe("$42.00")
  })

  it("thresholds on magnitude and re-attaches the sign for negatives", () => {
    // Raw-threshold form rendered "$-1500.00" / "$-42.00"; the sign belongs
    // before the $ and the K-abbreviation must apply to the magnitude.
    expect(fmtDollars(-1500)).toBe("-$1.5K")
    expect(fmtDollars(-42)).toBe("-$42.00")
    expect(fmtDollars(0)).toBe("$0.00")
  })
})

import { describe, it, expect } from "vitest"
import { isSameReport } from "@/lib/concierge/feedback-dedupe"

// The four rows webz_80's 10-11 session produced for two asks (10792/10795, 10793/10796).
describe("isSameReport", () => {
  it("matches a re-phrased bug report", () => {
    expect(isSameReport(
      "Alerts fire daily for the same condition instead of once at the moment of listing",
      "Alerts page fires repeated daily notifications for a moment that hasn't been relisted or changed",
    )).toBe(true)
  })
  it("matches a re-phrased feature request", () => {
    expect(isSameReport(
      "Alerts page: option to set alert frequency — fire once per new listing event vs. recurring",
      "Alerts page: option to configure alert frequency — fire once, or only when a moment is relisted",
    )).toBe(true)
  })
  it("keeps genuinely different reports apart", () => {
    expect(isSameReport("Team checklist omits Series 1 Legendary editions", "Sniper feed blank on Golazos")).toBe(false)
    expect(isSameReport("Add a dark mode toggle to the sets page", "Alerts fire daily for the same listing")).toBe(false)
  })
})

// @vitest-environment jsdom
import { describe, it, expect } from "vitest"
import type React from "react"
import { render } from "@testing-library/react"
import { rainbowCoverageNote } from "@/app/insights/candy-mlb/CandyBoardClient"

/**
 * The pack-EV card said the Rainbow leg was "largely unpriced (25/25)" — a
 * hardcoded adjective from July, printed beside a count that had reached 25 of
 * 25. The adjective now follows the count; this pins the absence of the false
 * claim at full coverage, and keeps the true one where it still holds.
 */
const text = (n: React.ReactNode) => render(<>{n}</>).container.textContent ?? ""

describe("rainbowCoverageNote", () => {
  it("never calls a fully priced leg 'unpriced'", () => {
    const t = text(rainbowCoverageNote(25, 25))
    expect(t).not.toMatch(/unpriced/i)
    expect(t).toContain("fully priced (25/25)")
  })
  it("still says 'largely unpriced' when it is", () => {
    expect(text(rainbowCoverageNote(3, 25))).toContain("largely unpriced (3/25)")
  })
  it("partial coverage reads as partial", () => {
    expect(text(rainbowCoverageNote(13, 25))).toContain("partly priced (13/25)")
  })
  it("an unreadable count states no coverage claim at all", () => {
    const t = text(rainbowCoverageNote(null, 25))
    expect(t).not.toMatch(/priced \(/)
  })
})

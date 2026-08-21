import { describe, it, expect } from "vitest"
import { sectionEmptyCopy, sectionUnavailableCopy } from "@/lib/entity/section-empty-copy"

// The entity-section counterpart of lib/og/board-empty-copy.ts: one place that
// decides what a section with no rows says, so a degraded read can never be
// published as a fact about the data.

describe("sectionEmptyCopy", () => {
  it("returns the caller's own wording when the read SUCCEEDED and the section is empty", () => {
    // ⚠ The empty copy must pass through untouched. A section that says
    // "unavailable" when it is merely quiet is this same defect inverted, and it
    // would fire on every genuinely quiet edition.
    expect(sectionEmptyCopy(true, "Recent sales", "No sales yet.")).toBe("No sales yet.")
    expect(sectionEmptyCopy(true, "Offers", "No open offers on this edition.")).toBe(
      "No open offers on this edition.",
    )
  })

  it("returns an UNAVAILABLE sentence when the read failed — never a claim about the data", () => {
    const copy = sectionEmptyCopy(false, "Recent sales", "No sales yet.")
    // Assert the ABSENCE of the false claim, not merely the presence of a word:
    // a helper that appended "unavailable" to "No sales yet." would satisfy a
    // presence-only check while still telling the reader there are no sales.
    expect(copy).not.toContain("No sales")
    expect(copy).not.toMatch(/\bno\b/i)
    expect(copy).toContain("couldn't be loaded")
  })

  it("leads with the caller's noun so the sentence reads naturally", () => {
    expect(sectionUnavailableCopy("Top sales")).toBe("Top sales couldn't be loaded — refresh to try again.")
    expect(sectionEmptyCopy(false, "Offers", "x")).toMatch(/^Offers /)
  })

  it("offers a next step rather than a dead end", () => {
    // An error state with nothing to do reads as a broken page.
    expect(sectionUnavailableCopy("Recent sales")).toMatch(/refresh|try again/i)
  })

  it("the two states never produce the same string for the same section", () => {
    const noun = "Recent sales"
    const empty = "No sales yet."
    expect(sectionEmptyCopy(true, noun, empty)).not.toBe(sectionEmptyCopy(false, noun, empty))
  })
})

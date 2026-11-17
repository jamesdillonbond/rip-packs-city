import { describe, it, expect } from "vitest"
import { normalizePlayDescription, isSentinel } from "@/lib/topshot/play-description"

// The Top Shot play description is the only narrative text in the catalog, and
// the thing that makes a query like "game winner" answerable at all. These pin
// the storage contract: null rather than empty string (so "has prose" is a
// plain IS NOT NULL test), collapsed whitespace (so a trigram index over it
// matches consistently), and the upstream's SENTINEL values treated as absent
// rather than stored as literal text.

const REAL_SAMPLE =
  "Mike James has returned to make an impact at the NBA level. The Brooklyn Nets guard drives hard along the baseline to leap way up for an elevated three-pointer in his first game back. James finished with eight points in the April 23, 2021 win over the Boston Celtics."

describe("normalizePlayDescription", () => {
  it("keeps real prose intact", () => {
    expect(normalizePlayDescription(REAL_SAMPLE)).toBe(REAL_SAMPLE)
  })

  it("returns null — never an empty string — for blank input", () => {
    // "has prose?" must stay a plain IS NOT NULL test.
    expect(normalizePlayDescription("")).toBeNull()
    expect(normalizePlayDescription("   ")).toBeNull()
    expect(normalizePlayDescription("\n\t ")).toBeNull()
  })

  it("returns null for a non-string", () => {
    expect(normalizePlayDescription(null)).toBeNull()
    expect(normalizePlayDescription(undefined)).toBeNull()
    expect(normalizePlayDescription(42)).toBeNull()
    expect(normalizePlayDescription({})).toBeNull()
  })

  it("collapses newlines and doubled spaces so trigram matching is consistent", () => {
    expect(normalizePlayDescription("Lillard  drills\n\na three\tfrom deep.")).toBe(
      "Lillard drills a three from deep."
    )
  })

  it("trims leading and trailing whitespace", () => {
    expect(normalizePlayDescription("  A clean block.  ")).toBe("A clean block.")
  })

  it("treats a sentinel-only value as absent, not as text", () => {
    // Top Shot returns "N/A" / "NA" in place of null on sibling fields; storing
    // the literal string would make it searchable and render as a description.
    expect(normalizePlayDescription("N/A")).toBeNull()
    expect(normalizePlayDescription("NA")).toBeNull()
    expect(normalizePlayDescription("  none  ")).toBeNull()
    expect(normalizePlayDescription("-")).toBeNull()
  })

  it("does not strip a sentinel word that is part of real prose", () => {
    const s = "NA East champions clinched the series."
    expect(normalizePlayDescription(s)).toBe(s)
  })
})

describe("isSentinel", () => {
  it("flags the exact placeholders the upstream returned in the live probe", () => {
    // Measured 2026-08-11: draftYear: 0, draftRound: "N/A", quarter: "NA".
    expect(isSentinel(0)).toBe(true)
    expect(isSentinel("N/A")).toBe(true)
    expect(isSentinel("NA")).toBe(true)
  })

  it("flags null, undefined and empty", () => {
    expect(isSentinel(null)).toBe(true)
    expect(isSentinel(undefined)).toBe(true)
    expect(isSentinel("")).toBe(true)
    expect(isSentinel("   ")).toBe(true)
  })

  it("does not flag real values", () => {
    expect(isSentinel("Brooklyn Nets")).toBe(false)
    expect(isSentinel(73)).toBe(false)
    expect(isSentinel("55")).toBe(false)
    expect(isSentinel("2020-21")).toBe(false)
  })

  it("does not treat a non-zero number or an object as a sentinel", () => {
    expect(isSentinel(2021)).toBe(false)
    expect(isSentinel({})).toBe(false)
  })
})

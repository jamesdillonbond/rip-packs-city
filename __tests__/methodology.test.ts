import { describe, it, expect } from "vitest"
import { METHODOLOGY, METHODOLOGY_LIST } from "@/lib/analytics/methodology"

// Static methodology copy for the analytics dashboards. Pure data — verify each
// entry's key matches its own slug, required fields are populated, and the
// derived list mirrors the record's values in insertion order.

describe("METHODOLOGY record", () => {
  it("keys every entry by its own slug", () => {
    for (const [key, entry] of Object.entries(METHODOLOGY)) {
      expect(entry.slug).toBe(key)
    }
  })

  it("gives every entry a non-empty title, blurb, refresh, and >=1 paragraph + source", () => {
    for (const entry of Object.values(METHODOLOGY)) {
      expect(entry.title.length).toBeGreaterThan(0)
      expect(entry.blurb.length).toBeGreaterThan(0)
      expect(entry.refresh.length).toBeGreaterThan(0)
      expect(entry.paragraphs.length).toBeGreaterThan(0)
      expect(entry.paragraphs.every((p) => p.length > 0)).toBe(true)
      expect(entry.sources.length).toBeGreaterThan(0)
      expect(entry.sources.every((s) => s.length > 0)).toBe(true)
    }
  })

  it("has unique slugs", () => {
    const slugs = Object.values(METHODOLOGY).map((e) => e.slug)
    expect(new Set(slugs).size).toBe(slugs.length)
  })

  it("includes the core analytics sections", () => {
    for (const slug of ["loans", "sales", "fmv", "packs"]) {
      expect(METHODOLOGY[slug]).toBeDefined()
    }
  })
})

describe("METHODOLOGY_LIST", () => {
  it("mirrors the record's values in order", () => {
    expect(METHODOLOGY_LIST).toEqual(Object.values(METHODOLOGY))
    expect(METHODOLOGY_LIST).toHaveLength(Object.keys(METHODOLOGY).length)
  })
})

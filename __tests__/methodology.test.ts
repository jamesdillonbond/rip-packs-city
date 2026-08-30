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

// ── The methodology must not describe a page cache as a data cadence ────────
//
// 🚨 WHY (2026-08-29). The Listings entry paired "Live Top Shot ask data comes from
// edition_offers" with `refresh: "Every 5 minutes (page revalidate)"` — which is the
// PAGE's revalidate, not the ask feed's. Read together they said the asks are five
// minutes old. `edition_offers` has ONE writer for the ask side, `offers-sweep`, and
// when its upstream died the column sat unrefreshed for over 30 hours while this page
// still implied minutes. ⭐ The two numbers are different measurements and stating only
// the flattering one is the same shape as the boards' retired "Refreshes continuously".
describe("methodology does not pass a page cache off as a data cadence", () => {
  it("is not vacuous: the Listings entry exists and still states a refresh", () => {
    expect(METHODOLOGY.listings).toBeDefined()
    expect(String(METHODOLOGY.listings.refresh).length).toBeGreaterThan(0)
  })

  it("the Listings refresh names the FEED's cadence, not just the page's", () => {
    const r = String(METHODOLOGY.listings.refresh)
    // Assert the ABSENCE of the bare claim, not merely the presence of a word: the
    // defect was a true statement about the page standing in for one about the data.
    expect(
      /^every 5 minutes \(page revalidate\)$/i.test(r.trim()),
      "the refresh line describes only the page cache, which reads as the ask age",
    ).toBe(false)
    expect(r).toMatch(/feed|ask|hourly/i)
  })

  it("every paragraph about the edition ask feed states how recently it was confirmed", () => {
    // ⚠ THE FIRST VERSION OF THIS BANNED ANY "live ask" AND WAS TOO BLUNT — it fired on
    // the Packs entry, whose sentence reads "a 20-minute cron … stamps each row with the
    // live ask price". That claim IS bounded, in the same breath, and the pack-ask feed
    // was measurably healthy (282/282 ok) on the day this was written. A guard that reds
    // on an accurate, qualified statement teaches people to delete the qualifier.
    // The real property is narrower: the feed that broke is `edition_offers`, so any
    // paragraph naming it must also say how current it is.
    const paras = Object.values(METHODOLOGY).flatMap((e) => e.paragraphs)
    const mentions = paras.filter((p) => /edition_offers/.test(p))
    expect(mentions.length, "no paragraph names the feed — this guard reads nothing").toBeGreaterThan(0)
    const unbounded = mentions.filter(
      (p) => !/hourly|confirm|re-check|recently|cadence|not a guarantee/i.test(p),
    )
    expect(
      unbounded.join("\n---\n"),
      "the ask feed is described with no statement of how recently it was confirmed",
    ).toBe("")
  })
})

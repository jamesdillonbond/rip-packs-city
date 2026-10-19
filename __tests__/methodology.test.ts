import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
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

describe("/legal/fmv-methodology landmark (axe `region`, 2026-10-12)", () => {
  it("wraps the <article> in exactly one <main>", () => {
    const src = readFileSync(join(__dirname, "..", "app", "legal", "fmv-methodology", "page.tsx"), "utf8")
    expect(src.match(/<main>/g) ?? []).toHaveLength(1)
    expect(src.match(/<\/main>/g) ?? []).toHaveLength(1)
    expect(src.indexOf("<main>")).toBeLessThan(src.indexOf("<article"))
    expect(src.indexOf("</article>")).toBeLessThan(src.indexOf("</main>"))
  })
})

// 2026-10-18 (Trevor: "We shouldn't have anything user-facing that shows our
// confidence in the pricing. That should just be for internal use."). Both
// methodology surfaces are public prose; they may state the FACTS (sale-priced
// vs ask-priced, withheld when too little data) but never the internal tiers.
// Tier names are matched case-SENSITIVELY (plain "low-supply" / "high-momentum"
// prose is fine); the word "confidence" in any case is not.
const TIER_NAMES = /\b(?:HIGH|MEDIUM|LOW|ASK_ONLY|SALES_ONLY|NO_DATA|STALE)\b/
const CONFIDENCE_WORD = /confidence/i
const TIER_VOCAB = { test: (t: string) => TIER_NAMES.test(t) || CONFIDENCE_WORD.test(t) }

describe("methodology copy publishes no FMV confidence tiers", () => {
  it("no METHODOLOGY entry names a confidence tier or the word 'confidence'", () => {
    const offenders: string[] = []
    for (const e of METHODOLOGY_LIST) {
      for (const text of [e.title, e.blurb, e.refresh, ...e.paragraphs, ...e.sources]) {
        if (TIER_VOCAB.test(text)) offenders.push(`${e.slug}: ${text.slice(0, 80)}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it("the population is non-empty (the scan above read something)", () => {
    expect(METHODOLOGY_LIST.flatMap((e) => e.paragraphs).length).toBeGreaterThan(10)
  })

  it("/legal/fmv-methodology renders no tier names, thresholds or 'Confidence Levels' section", async () => {
    const { stripComments } = await import("../scripts/lib/strip-comments.mjs")
    const src = readFileSync(join(__dirname, "..", "app", "legal", "fmv-methodology", "page.tsx"), "utf8")
    const code: string = stripComments(src)
    expect(code).not.toMatch(TIER_NAMES)
    expect(code).not.toMatch(CONFIDENCE_WORD)
    expect(code).not.toMatch(/fmv-confidence/)
    // The factual withholding statement survives.
    expect(code).toMatch(/withhold the price/)
    expect(code).toMatch(/from asks/)
  })
})

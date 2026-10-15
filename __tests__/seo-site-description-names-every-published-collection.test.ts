import { describe, it, expect } from "vitest"
import { COLLECTIONS } from "@/lib/collections"
import { publishedCollectionsPhrase, organizationJsonLd, rootMetadata, collectionLayoutMetadata } from "@/lib/seo"

// 2026-10-14. The root <meta description> and the root WebApplication JSON-LD
// (on EVERY page) were hand-written lists that stopped at UFC Strike and said
// "on Flow blockchain" — Candy MLB (Solana) and Panini were missing from the
// site's own description of itself, and the whole catalogue was called Flow.
// Both now derive from the registry; this pins the property, not the spelling.

const published = COLLECTIONS.filter((c) => c.published)

describe("site-wide description derives from the published registry", () => {
  it("names every published collection, in the phrase, the root description and the root JSON-LD", () => {
    const phrase = publishedCollectionsPhrase()
    const rootDesc = String(rootMetadata.description ?? "")
    for (const c of published) {
      expect(phrase).toContain(c.label)
      expect(rootDesc).toContain(c.label)
      expect(organizationJsonLd.description).toContain(c.label)
    }
  })

  it("never calls the whole catalogue Flow: a non-Flow collection is not listed before 'on Flow'", () => {
    const phrase = publishedCollectionsPhrase()
    const flowAt = phrase.indexOf(" on Flow")
    expect(flowAt).toBeGreaterThan(0)
    for (const c of published.filter((x) => x.dbChain !== "flow")) {
      expect(phrase.indexOf(c.label)).toBeGreaterThan(flowAt)
    }
    expect(organizationJsonLd.description).not.toMatch(/on Flow blockchain/)
  })

  it("a collection with no established chain carries no chain claim", () => {
    const phrase = publishedCollectionsPhrase()
    for (const c of published.filter((x) => !x.dbChain)) {
      expect(phrase).not.toMatch(new RegExp(`${c.label} on `))
    }
  })
})

describe("Panini collection metadata is not World-Cup-only (all-product since 2026-10-10)", () => {
  it("title and description do not describe the collection as Prizm World Cup", () => {
    const m = collectionLayoutMetadata("panini-blockchain")
    const title = typeof m.title === "string" ? m.title : JSON.stringify(m.title)
    expect(title).not.toMatch(/World Cup/)
    expect(String(m.description)).not.toMatch(/World Cup/)
  })
})

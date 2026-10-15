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

import { chanceHitExplainerHref, getBlogPost } from "@/lib/blog/posts"

describe("Chance Hit pack pages link the Premium Chance Hit explainer (2026-10-14)", () => {
  it("links from Top Shot Chance Hit / Premium Chance Hit packs to a post that exists", () => {
    const href = chanceHitExplainerHref("nba-top-shot", "2026 NBA Playoffs: Premium Chance Hit")
    expect(href).toBe("/blog/premium-chance-hit-vs-chance-hit")
    expect(getBlogPost(href!.replace("/blog/", ""))).toBeDefined()
    expect(chanceHitExplainerHref("nba-top-shot", "Rookie Rush: Chance Hit")).toBe(href)
  })
  it("no link on other packs or other collections", () => {
    expect(chanceHitExplainerHref("nba-top-shot", "WNBA Metallic Gold LE Premium Pack")).toBeNull()
    expect(chanceHitExplainerHref("nfl-all-day", "Some Chance Hit Pack")).toBeNull()
  })
})

import { pageMetadata, PUBLIC_TAB_PAGES } from "@/lib/seo"

describe("collection tab metadata (live audit, 2026-10-14)", () => {
  const published = COLLECTIONS.filter((c) => c.published)

  it("every public tab of every published collection carries an og:image and a twitter:image", () => {
    for (const c of published) {
      for (const page of (c.pages ?? []).filter((p) => PUBLIC_TAB_PAGES.includes(p))) {
        const m = pageMetadata(page, c.label, c.id) as any
        expect(m.openGraph?.images?.length, `${c.id}/${page} og:image`).toBeGreaterThan(0)
        expect(m.twitter?.images?.length, `${c.id}/${page} twitter:image`).toBeGreaterThan(0)
      }
    }
  })

  it("a non-Flow collection's tab copy never names Flow or the Flow collections", () => {
    for (const c of published.filter((x) => x.dbChain !== "flow")) {
      for (const page of (c.pages ?? []).filter((p) => PUBLIC_TAB_PAGES.includes(p))) {
        const m = pageMetadata(page, c.label, c.id) as any
        const text = `${m.title} ${m.description}`
        expect(text, `${c.id}/${page}`).not.toMatch(/\bFlow\b|Top Shot|All Day|Golazos|UFC/)
      }
    }
  })

  it("the analytics tab is described as the MARKET analytics it renders, not a wallet breakdown", () => {
    const m = pageMetadata("analytics", "NBA Top Shot", "nba-top-shot") as any
    expect(`${m.title} ${m.description}`).not.toMatch(/portfolio clarity|liquid vs locked|acquisition origin/i)
    expect(String(m.description)).toMatch(/top sales/i)
  })
})

import { insightsHubJsonLd, getInsightsBoard } from "@/lib/insights/board-registry"
import { INSIGHT_ROUTES } from "@/lib/sitemap-data"

describe("/insights hub JSON-LD (2026-10-14)", () => {
  it("lists exactly the live boards the sitemap advertises, each by its registry name and URL", () => {
    const ld = insightsHubJsonLd(INSIGHT_ROUTES, "https://www.rippackscity.com") as any
    const items = ld.mainEntity.itemListElement
    const expected = INSIGHT_ROUTES.filter((s) => getInsightsBoard(s))
    expect(items.map((i: any) => i.url)).toEqual(expected.map((s) => `https://www.rippackscity.com/insights/${s}`))
    expect(ld.mainEntity.numberOfItems).toBe(items.length)
    expect(items.length).toBeGreaterThan(20)
  })
  it("a staged (not-live) or unknown slug is never advertised", () => {
    const ld = insightsHubJsonLd(["squeeze", "not-a-board"], "https://x.test") as any
    expect(ld.mainEntity.itemListElement.map((i: any) => i.url)).toEqual(["https://x.test/insights/squeeze"])
  })
})

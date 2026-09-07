import { describe, it, expect } from "vitest"
import { readFileSync } from "fs"
import path from "path"
import { editionHref } from "@/lib/entity-href"

// 2026-09-07 (Search Console pass, part two). Three properties:
//
//   1. editionHref() builds the CANONICAL edition-page URL from an edition row,
//      never the /moment/<edition uuid> resolver URL when an external_id exists
//      (that URL now 308s — every internal link to it was a redirect hop and a
//      duplicate URL for the crawler).
//   2. The "Same Play · Other Sets" cards on the edition page and the Parallels
//      cards on the moment page use it. The edition page also renders a "More
//      from this player / set" block off get_edition_related — the site's only
//      edition→edition links besides parallels (measured 0 on a live edition
//      page before this).
//   3. The pack-dist page never publishes "Retail $0.00" (a $0 retail is an
//      unrecorded price, not a price) and its title says what the page answers.

const ROOT = path.resolve(__dirname, "..")
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8")

describe("editionHref", () => {
  it("links to /<collection>/edition/<external_id>, URL-encoded", () => {
    expect(editionHref("nba-top-shot", "99:3372", "1d24f53d-a3aa-49dd-9606-38bd87ba1153")).toBe("/nba-top-shot/edition/99%3A3372")
    expect(editionHref("nba-top-shot", "99:3372::7", "x")).toBe("/nba-top-shot/edition/99%3A3372%3A%3A7")
    expect(editionHref("nfl-all-day", "4408", "x")).toBe("/nfl-all-day/edition/4408")
  })
  it("keys Pinnacle on the edition id (its route convention), ignoring external_id", () => {
    expect(editionHref("disney-pinnacle", "STAR-OEV1", "abc")).toBe("/disney-pinnacle/edition/abc")
  })
  it("falls back to the resolver URL ONLY when there is no external_id (never guesses a slug)", () => {
    expect(editionHref("nba-top-shot", null, "1d24f53d-a3aa-49dd-9606-38bd87ba1153")).toBe("/moment/1d24f53d-a3aa-49dd-9606-38bd87ba1153")
    expect(editionHref("nba-top-shot", "  ", "id")).toBe("/moment/id")
  })
})

describe("the edition page links edition→edition through the canonical URL", () => {
  const src = read("app/(collections)/[collection]/edition/[slug]/page.tsx")
  it("no card on the edition page links to /moment/<edition uuid> by template", () => {
    expect(src).not.toMatch(/href=\{`\/moment\/\$\{p\.id\}`\}/)
    expect(src).toContain("href={editionHref(collection, p.external_id, p.id)}")
  })
  it("renders the related block off get_edition_related and links each row canonically", () => {
    expect(src).toContain('"get_edition_related"')
    expect(src).toContain("href={editionHref(collection, r.external_id, r.id)}")
    // Not for Pinnacle — its editions are not in `editions`.
    expect(src).toMatch(/isPinnacle \? Promise\.resolve\(\[\] as RelatedEdition\[\]\) : fetchRelated\(detail\.id\)/)
  })
})

describe("the moment page's Parallels cards link canonically too", () => {
  const src = read("app/moment/[id]/page.tsx")
  it("uses editionHref when the collection slug is known", () => {
    expect(src).toContain("editionHref(walletSlug, p.external_id, p.id)")
    expect(src).not.toMatch(/href=\{`\/moment\/\$\{p\.id\}`\}/)
  })
})

describe("pack-dist metadata", () => {
  const src = read("app/(collections)/[collection]/pack/dist/[distId]/page.tsx")
  it("withholds the Retail sentence unless the price is positive", () => {
    expect(src).toMatch(/price !== null && price > 0 \? `Retail \$\{fmtUsd\(price\)\}\.` : null/)
  })
  it("titles the page on what it answers (odds, pulls, EV), not a bare tier word", () => {
    expect(src).toContain("· Odds, Pulls & EV |")
  })
})

// robots.txt must never Disallow a PUBLISHED collection's URL space.
//
// 2026-10-03 (Search Console read): `Disallow: /panini-blockchain/` had been in
// app/robots.ts since 2026-04-26 ("unpublished collection") and survived both
// the 09-25 publish (registry `published: true`, shared [collection] routes) and
// the 09-27 sitemap enumeration (~16.7K Panini edition/player/set URLs). Result:
// GSC "Blocked by robots.txt" 1,472 and climbing, every one a sitemap-submitted,
// `index, follow`, self-canonical 200 — the sitemap invited Googlebot to pages
// robots.txt forbade. No guard tied the Disallow list to the registry, so the
// stale line could not be noticed by anything but a human reading GSC.
//
// Population: every `published: true` registry entry (ban at zero, derived from
// the registry — not a curated list, so the next collection to flip `published`
// is covered the moment it flips). No-change control: the Disallows that must
// stay (the API, the share pages, the user-scoped query permutations) are still
// present, so the test cannot pass by emptying the list.

import { describe, expect, it } from "vitest"
import robots from "@/app/robots"
import { publishedCollections } from "@/lib/collections"

function disallows(): string[] {
  const rules = robots().rules
  const list = Array.isArray(rules) ? rules : [rules]
  return list.flatMap((r) => {
    const d = (r as { disallow?: string | string[] }).disallow
    return d === undefined ? [] : Array.isArray(d) ? d : [d]
  })
}

describe("robots: a published collection is never Disallowed", () => {
  const published = publishedCollections()

  it("the population is non-empty (a vacuous pass is not a pass)", () => {
    expect(published.length).toBeGreaterThan(0)
  })

  for (const c of published) {
    it(`does not block /${c.id}/ (published)`, () => {
      const offenders = disallows().filter((d) => d === `/${c.id}` || d.startsWith(`/${c.id}/`))
      expect(offenders, `robots.txt Disallows the published collection ${c.id}`).toEqual([])
    })
  }

  it("the image proxies the pages render through are carved out of Disallow /api/ (GSC 10-03: ipfs-media led the Blocked-by-robots examples)", () => {
    const rules = robots().rules
    const list = Array.isArray(rules) ? rules : [rules]
    const allows = list.flatMap((r) => {
      const a = (r as { allow?: string | string[] }).allow
      return a === undefined ? [] : Array.isArray(a) ? a : [a]
    })
    for (const must of [
      "/api/public/ipfs-media/",
      "/api/public/ipfs-thumb/",
      "/api/public/pinnacle-image/",
      "/api/public/team-logo",
      "/api/public/avatar-media",
    ]) {
      expect(allows, `expected Allow ${must}`).toContain(must)
      // Longest-match-wins: each Allow must be longer than the `/api/` Disallow it overrides.
      expect(must.length).toBeGreaterThan("/api/".length)
    }
  })

  it("no-change control: the API, share pages and user-scoped query permutations stay blocked", () => {
    const d = disallows()
    for (const must of ["/api/", "/share/", "/*?wallet=", "/*?owner=", "/*?address="]) {
      expect(d, `expected Disallow ${must} to survive`).toContain(must)
    }
  })
})

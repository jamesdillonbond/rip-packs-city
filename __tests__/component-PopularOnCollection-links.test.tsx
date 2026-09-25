// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest"

// distinctSlugLinks is the pure core of the SEO internal-link fan-out on the
// /overview page — it turns raw entity names into the first `cap` distinct hub
// links, deduped by slug, with an exhibition-team drop. A regression here either
// pollutes the crawl graph with junk hubs or silently loses internal links, so
// pin each branch (blank/dedup/exhibition/cap). Named .test.tsx so it runs under
// the component-coverage gate (the file it exercises lives in components/).
//
// ⚠ The stub below is VESTIGIAL and kept only as a cheap guard. This module
// stopped referencing supabaseAdmin on 2026-08-17 (the reads moved to
// lib/entity/popular-on-collection-fetchers), which is also what made the
// component body renderable — see
// __tests__/component-PopularOnCollection-render.test.tsx. Removing it would be
// safe today; leaving it means a re-introduced direct client cannot quietly
// reach a live Supabase from this suite.
vi.mock("@/lib/supabase", () => ({ supabaseAdmin: {} }))

import { distinctSlugLinks, dedupeLinksBySubject } from "@/components/entity/PopularOnCollection"

describe("distinctSlugLinks", () => {
  it("builds collection/segment-scoped hrefs and keeps the raw name as the label", () => {
    const out = distinctSlugLinks(["Damian Lillard"], "nba-top-shot", "player", 12)
    expect(out).toEqual([
      { href: "/nba-top-shot/player/damian-lillard", label: "Damian Lillard" },
    ])
  })

  it("skips blank / whitespace-only names", () => {
    const out = distinctSlugLinks([null, undefined, "", "   ", "Real Set"], "nba-top-shot", "set", 12)
    expect(out.map((l) => l.label)).toEqual(["Real Set"])
  })

  it("dedupes by slug (first occurrence wins, later variants collapse)", () => {
    const out = distinctSlugLinks(["Base Set", "base   set", "BASE SET", "Other"], "nba-top-shot", "set", 12)
    expect(out.map((l) => l.label)).toEqual(["Base Set", "Other"])
  })

  it("drops exhibition/all-star rosters only when dropExhibition is set", () => {
    const kept = distinctSlugLinks(["Team LeBron", "Portland Trail Blazers"], "nba-top-shot", "team", 10)
    expect(kept.map((l) => l.label)).toEqual(["Team LeBron", "Portland Trail Blazers"])

    const dropped = distinctSlugLinks(["Team LeBron", "Portland Trail Blazers"], "nba-top-shot", "team", 10, true)
    expect(dropped.map((l) => l.label)).toEqual(["Portland Trail Blazers"])
  })

  it("caps the output at `cap` distinct links", () => {
    const names = ["A one", "B two", "C three", "D four"]
    const out = distinctSlugLinks(names, "nba-top-shot", "player", 2)
    expect(out).toHaveLength(2)
    expect(out.map((l) => l.label)).toEqual(["A one", "B two"])
  })

  it("url-encodes the slug in the href", () => {
    const out = distinctSlugLinks(["St. John's"], "nba-top-shot", "team", 10)
    expect(out[0].href).toBe("/nba-top-shot/team/st-john-s")
  })
})

// 2026-09-24 — the edition tiles are one per subject + set. The lowest-mint
// sample over Candy MLB's parallel-heavy catalogue rendered the same six
// players' colour variants (Murakami ×4, Caminero ×5, Trout ×3 of 18 tiles).
describe("dedupeLinksBySubject", () => {
  const l = (name: string, sub: string | null, href: string) => ({ name, sub, href })
  it("keeps the first tile per subject + set and caps at max", () => {
    const out = dedupeLinksBySubject(
      [
        l("Munetaka Murakami", "2026 MLB Base Series ICONs", "/a"),
        l("Munetaka Murakami", "2026 MLB Base Series ICONs", "/a-blue"),
        l("Mike Trout", "2026 MLB Base Series ICONs", "/b"),
        l("Munetaka Murakami", "2026 MLB Base Series ICONs", "/a-pink"),
        l("Mike Trout", "Some Other Set", "/b2"),
        l("Paul Skenes", "2026 MLB Base Series ICONs", "/c"),
      ],
      3,
    )
    expect(out.map((x) => x.href)).toEqual(["/a", "/b", "/b2"])
  })
  it("a subject in two sets is two tiles (the set is on the tile)", () => {
    const out = dedupeLinksBySubject([l("X", "S1", "/1"), l("X", "S2", "/2")], 18)
    expect(out).toHaveLength(2)
  })
})

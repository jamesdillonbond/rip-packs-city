// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest"

// distinctSlugLinks is the pure core of the SEO internal-link fan-out on the
// /overview page — it turns raw entity names into the first `cap` distinct hub
// links, deduped by slug, with an exhibition-team drop. A regression here either
// pollutes the crawl graph with junk hubs or silently loses internal links, so
// pin each branch (blank/dedup/exhibition/cap). Named .test.tsx so it runs under
// the component-coverage gate (the file it exercises lives in components/).
//
// The module references supabaseAdmin at import time, so stub it before import.
vi.mock("@/lib/supabase", () => ({ supabaseAdmin: {} }))

import { distinctSlugLinks } from "@/components/entity/PopularOnCollection"

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

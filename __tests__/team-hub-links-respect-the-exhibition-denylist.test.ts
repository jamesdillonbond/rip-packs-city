// __tests__/team-hub-links-respect-the-exhibition-denylist.test.ts
//
// /[collection]/team/[slug] notFound()s the 12 exhibition/all-star rosters in
// lib/team-denylist.ts, and BOTH lib/sitemap-data.ts and PopularOnCollection
// filter them out. FOUR href builders did not.
//
// Three of them (edition, player, moment) take the team name from MOMENT
// METADATA — an open vocabulary that contains the all-star rosters — and so
// rendered an in-app <Link> to a guaranteed 404 on 100 Top Shot edition pages
// (measured 2026-09-11) plus their player and moment pages.
//
// The fourth (/my-teams) takes its slug from `teams_master`: 97 curated league
// rows, 0 of them denylisted, 12 follows, 0 denylisted (measured 2026-09-11).
// It could not produce a bad link today — but that is a property of the DATA,
// which one INSERT changes silently, so it is gated rather than suppressed.
//
// ⭐ THE WALK FOUND THE FOURTH ONE. This guard was written believing there were
// three; the tree walk red-flagged app/my-teams/page.tsx on its first run, which
// is the entire argument for the walk over a list.
//
// ⭐ THE SHAPE, not the instance: gating a ROUTE is only half a gate. CLAUDE.md
// already says "before gating/short-circuiting any route, enumerate EVERY
// caller" about fetchers; this is the same rule applied to inbound LINKS, and
// nothing was watching that direction.
//
// ⚠ THIS IS A TREE WALK, NOT A CURATED LIST OF THE THREE KNOWN FILES. A
// three-name allowlist would have gone green the moment a fourth builder was
// added, which is exactly how this defect arrived. The SUPPRESSION is the
// curated part.
//
// ⚠ AND IT ASSERTS THE COUNT IT INSPECTED. A walk that matches nothing — a
// renamed directory, a changed template-literal spelling — passes vacuously and
// reads as coverage. The floor below fails loudly instead.

import { describe, expect, it } from "vitest"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"

const ROOTS = ["app", "components"]

/** Builders that legitimately name a team route without linking a user to it. */
const SUPPRESSED = new Set<string>([
  // The denylist's own home, and the route that DOES the 404ing.
  "lib/team-denylist.ts",
  "app/(collections)/[collection]/team/[slug]/page.tsx",
  "app/(collections)/[collection]/team/[slug]/layout.tsx",
])

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.tsx?$/.test(p)) out.push(p)
  }
  return out
}

// `/team/${...}` inside a template literal — the shape every builder uses.
const TEAM_HREF = /\/team\/\$\{/

describe("every team-hub link builder respects the exhibition denylist", () => {
  const files = ROOTS.flatMap((r) => walk(r)).filter((f) => !SUPPRESSED.has(f.replace(/\\/g, "/")))
  const builders = files.filter((f) => TEAM_HREF.test(readFileSync(f, "utf8")))

  it("🚨 NOT VACUOUS — the walk found the team-href builders it exists to police", () => {
    // If this floor ever fails, the walk stopped seeing the population; fix the
    // walk before trusting the assertion below.
    expect(builders.length).toBeGreaterThanOrEqual(3)
  })

  it.each(builders)("%s gates its team href on isExhibitionTeamSlug", (file) => {
    const src = readFileSync(file, "utf8")
    // Assert the PROPERTY (the denylist is consulted in this file), not a
    // particular spelling of the call — a rename of the local variable must not
    // red this, and a dropped guard must.
    expect(src).toContain("isExhibitionTeamSlug")
  })
})

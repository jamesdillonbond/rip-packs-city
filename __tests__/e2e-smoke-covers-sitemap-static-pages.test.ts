import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { STATIC_SITEMAP_PAGES } from "@/lib/sitemap-data"
import { isPublicPath } from "@/proxy"

// COMPLETENESS: every page this repo TELLS GOOGLE TO CRAWL must be in the
// rendered-DOM monitor.
//
// ── WHY A SECOND COMPLETENESS GUARD ────────────────────────────────────────
// __tests__/e2e-smoke-covers-public-insights-boards.test.ts already does this
// for boards — and it is blind to everything else BY CONSTRUCTION, because it
// derives its population by walking `app/insights/*`. That is this repo's own
// "ask what a passing guard is structurally SILENT about" rule turned on a
// guard written to satisfy it. Measured 2026-08-20: the monitor's list was
// complete for /insights and missing EIGHT non-insights pages — /about,
// /privacy, /terms, /legal/fmv-methodology, the three /blog pages and
// /nba/fast-break — every one of them in the sitemap, and none of them in the
// only detector for the 200-but-broken-DOM and React #418 classes.
//
// ── WHY THE SITEMAP IS THE POPULATION, AND `isPublicPath` IS NOT ───────────
// ⚠ Sweeping `app/**/page.tsx` with `isPublicPath` returns 24 unlisted public
// paths, TWELVE of them `/admin/**`. Those are "public" only in the sense that
// proxy.ts does not redirect them — each admin page enforces its own
// RPC_ADMIN_TOKEN bearer check at the page level, so an anonymous visitor sees
// nothing. Demanding they be smoke-tested anonymously would rebuild, on twelve
// pages, exactly the cry-wolf failure e2e/smoke.spec.ts documents for
// /analytics (4/4 red on every run, "rendered only 0 chars", until they were
// removed). `isPublicPath` answers "does the proxy gate this", which is NOT the
// same question as "does an anonymous visitor see content".
//
// Sitemap membership answers the right one: it is this repo asserting that a
// path renders real content to an anonymous crawler. A URL we advertise to
// Googlebot and never check renders is precisely the gap worth closing — and
// the two are now held together here rather than by two hand-kept lists.
//
// ── WHAT THIS DOES NOT DEMAND ──────────────────────────────────────────────
// Only the STATIC half. `STATIC_SITEMAP_PAGES` is the hand-authored,
// non-database-derived segment-0 block; the per-collection tabs, entity pages
// and profile URLs are derived from live rows and are not enumerable here
// without a DB. It is also ONE-WAY: the monitor may cover more than the sitemap
// (it covers 30 boards and 22 collection tabs), so a listed-but-unsitemapped
// path is not an error. The reverse direction that DOES matter — a listed page
// that is not public at all — is already held by the insights guard's gated-
// board arm and by __tests__/sitemap-urls-are-anon-public.test.ts.

const SMOKE_SPEC = join(process.cwd(), "e2e", "smoke.spec.ts")

export function smokePaths(src: string): Set<string> {
  const out = new Set<string>()
  for (const m of src.matchAll(/path:\s*"([^"]+)"/g)) out.add(m[1])
  return out
}

function spec(): string {
  return readFileSync(SMOKE_SPEC, "utf8")
}

describe("the rendered-DOM smoke covers every static sitemap page", () => {
  it("both enumerators still find their populations (not vacuously passing)", () => {
    // ⚠ Asserts on the ENUMERATORS, never on how many pages are missing — a
    // not-vacuous check has to be satisfiable at a population of ZERO missing,
    // which is where this sits the moment it is written. A guard whose reader
    // silently returned an empty set would otherwise pass forever over nothing.
    expect(STATIC_SITEMAP_PAGES.length).toBeGreaterThan(8)
    expect(smokePaths(spec()).size).toBeGreaterThan(40)
  })

  it("every static sitemap page is in the monitor's list", () => {
    const listed = smokePaths(spec())
    const missing = STATIC_SITEMAP_PAGES.map((e) => e.path).filter((p) => !listed.has(p))
    expect(
      missing.join("\n"),
      "pages advertised in the sitemap but outside the rendered-DOM monitor — add them to " +
        "e2e/smoke.spec.ts. This is the only detector for React #418 and the blank-shell " +
        "class, and these are URLs Googlebot is told to crawl:\n" + missing.join("\n"),
    ).toBe("")
  })

  it("and every one of them really is anon-public, so the monitor cannot be armed against a login wall", () => {
    // The demand above is only safe while the sitemap keeps its own contract.
    // If a path in STATIC_SITEMAP_PAGES ever stops being public, this fails
    // HERE — in a sub-second blocking test naming the file — instead of turning
    // the 6-hourly live monitor permanently red on a page that 302s to /login.
    const gated = STATIC_SITEMAP_PAGES.map((e) => e.path).filter((p) => !isPublicPath(p, "GET"))
    expect(gated.join("\n"), "sitemap pages that proxy.ts gates:\n" + gated.join("\n")).toBe("")
  })

  // ── guards-the-guard ──────────────────────────────────────────────────────

  it("the path extractor reads the spec's real shape", () => {
    const sample = [
      '  { path: "/about", name: "about" },',
      '  { path: "/", name: "marketing home", expectText: /x/i },',
    ].join("\n")
    const got = smokePaths(sample)
    expect(got.has("/about")).toBe(true)
    expect(got.has("/")).toBe(true)
    expect(got.size).toBe(2)
  })

  it("would FAIL if a static sitemap page were dropped from the monitor", () => {
    // A completeness guard that cannot be shown to fail is indistinguishable
    // from one whose predicate is inverted. Drive the same comparison over a
    // spec body with one entry removed and require a non-empty diff.
    const withoutAbout = spec().replace('{ path: "/about", name: "about" },', "")
    const listed = smokePaths(withoutAbout)
    const missing = STATIC_SITEMAP_PAGES.map((e) => e.path).filter((p) => !listed.has(p))
    expect(missing).toEqual(["/about"])
  })

  it("uses the real isPublicPath, which discriminates", () => {
    expect(isPublicPath("/about", "GET")).toBe(true)
    expect(isPublicPath("/dashboard", "GET")).toBe(false)
  })
})

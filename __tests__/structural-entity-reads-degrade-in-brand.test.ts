// Every entity page with a STRUCTURAL section read must degrade THAT SECTION —
// not the whole page.
//
// ── THE DISTINCTION, because it is easy to read this as already-solved ──────
// `lib/entity-section-rpc.ts` marks some section reads `structural: true`: those
// THROW after retries rather than render a real entity with a convincingly empty
// catalogue. That throw is correct and is not what this guard is about.
//
// What each page owes is where it CATCHES. Three rungs, and the repo has stood
// on each of them in turn:
//
//   1. no catcher at all      → the segment error boundary, whole page gone
//   2. catch at the page      → the page's own `*Unavailable`, whole page gone
//   3. catch at the SECTION   → hero + stat strip survive; the section says so
//
// ⚠ Rung 2 was shipped 2026-08-23 and pinned by the FIRST version of this file,
// whose header said per-section "still beats this, and is still filed". This is
// that filing, done. **The guard is rewritten rather than deleted** — a test
// that pins a rung gets moved up to the next one, and the old assertion is left
// here inverted (see `must NOT return a whole-page`) so rung 2 cannot come back
// while still passing something called "degrade in brand".
//
// ── WHY RUNG 3 IS NOT A POLISH ITEM ────────────────────────────────────────
// The reads have different costs. On `/nba-top-shot/series/series-7`,
// `get_series_detail` answers in ~18 ms off `series_detail_rollup` while
// `get_series_editions` costs 6,615 ms / 32,484 buffers against an 8 s ceiling
// (R49) — so the editions read is the only one that fails, and rung 2 threw
// away a hero and five stat cells that were already read and already true.
// ⚠ On the TEAM page it is worse: the roster shares a six-way `Promise.all`, and
// a rejected `Promise.all` discards its SETTLED siblings. One roster timeout
// cost five sections that had come back fine.
//
// ⚠ DERIVED FROM THE TREE, NOT A LIST. The population is every
// `[collection]/*/[slug]/page.tsx` that contains a `structural: true` read, so a
// fifth entity page added tomorrow is inside this check by construction rather
// than by someone remembering to add it. A curated list drifts — this repo has
// recorded that twice.

import { describe, it, expect } from "vitest"
import { readdirSync, readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

const ENTITY_ROOT = join(process.cwd(), "app", "(collections)", "[collection]")

/** Every `[collection]/<entity>/[slug]/page.tsx` on disk. */
function entityPages(): Array<{ entity: string; src: string }> {
  const out: Array<{ entity: string; src: string }> = []
  for (const entry of readdirSync(ENTITY_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const p = join(ENTITY_ROOT, entry.name, "[slug]", "page.tsx")
    if (!existsSync(p)) continue
    out.push({ entity: entry.name, src: readFileSync(p, "utf8") })
  }
  return out
}

/**
 * Locate the page's structural fetcher and every place it is CALLED.
 *
 * ⚠ `[\s\S]{0,400}?` and NOT `[^}]*`: the fetcher's body passes an ARGS OBJECT
 * before the options object, so there is a `}` between the function brace and
 * `structural: true`. An earlier draft used `[^}]*` and matched nothing on all
 * four pages — only the `.not.toBeNull()` population check made that loud.
 */
function structuralFetcher(code: string): { name: string; callSites: number[] } | null {
  const declared = code.match(/async function (\w+)\([^)]*\)[^{]*\{[\s\S]{0,400}?structural: true/)
  if (!declared) return null
  const name = declared[1]
  const callSites = [...code.matchAll(new RegExp(`\\b${name}\\(`, "g"))]
    .map((m) => m.index!)
    .filter((i) => !code.slice(Math.max(0, i - 20), i).includes("function "))
  return { name, callSites }
}

describe("structural entity reads degrade per SECTION", () => {
  const pages = entityPages()
  // ⚠ Comments stripped: several of these pages EXPLAIN the structural throw in
  // prose, and a guard that greps source for its own subject must not match the
  // documentation. At least six guards in this repo have fired on a comment.
  const structural = pages.filter(({ src }) => stripComments(src).includes("structural: true"))

  it("inspected a non-trivial number of entity pages", () => {
    // A walk that silently finds nothing exits clean and reads as coverage.
    expect(pages.length, "no entity pages found — the walk is broken").toBeGreaterThanOrEqual(4)
    expect(
      structural.length,
      "no page carries a structural read — either the flag was renamed or the walk is wrong",
    ).toBeGreaterThanOrEqual(4)
  })

  it.each(structural.map((p) => [p.entity, p.src] as const))(
    "%s absorbs its structural throw at the section, keeping the rest of the page",
    (entity: string, src: string) => {
      const code = stripComments(src)
      const found = structuralFetcher(code)
      expect(found, `${entity}: could not locate the structural fetcher`).not.toBeNull()
      const { name, callSites } = found!
      expect(callSites.length, `${entity}: ${name} is declared but never called`).toBeGreaterThan(0)

      for (const at of callSites) {
        // The call must be handed to `structuralSection`, which is the only
        // thing that turns the throw into a value the render can branch on.
        const before = code.slice(Math.max(0, at - 200), at)
        expect(
          before,
          `${entity}: ${name}() is not passed to structuralSection() — its throw either escapes to the error boundary or is caught somewhere that cannot report per section`,
        ).toContain("structuralSection")

        // ⚠ THE INVERTED RUNG-2 ASSERTION. The previous version of this guard
        // REQUIRED exactly this shape. A page that reinstates it passes every
        // other check here while costing the reader the whole page again.
        const after = code.slice(at, at + 600)
        expect(
          after,
          `${entity}: the ${name}() call still routes into a whole-page *Unavailable — that is rung 2, and it discards a hero and stat strip that were already read`,
        ).not.toMatch(/\}\s*catch[^)]*\{[\s\S]{0,200}?return <\w*Unavailable/)
      }

      // The failure must reach the READER, not just the log. `ok` has to gate a
      // section-level view; without this the page renders an empty grid, which
      // is the two-state collapse the honesty canon forbids.
      const okVar = code.match(/\b(\w+Ok) = \w+\.ok\b/)
      expect(okVar, `${entity}: no \`…Ok = ….ok\` derived from the structural result`).not.toBeNull()
      expect(
        code,
        `${entity}: renders no <SectionUnavailable> — a failed structural read would show an empty section instead of saying it failed`,
      ).toContain("<SectionUnavailable")
      expect(
        code.match(new RegExp(`\\b${okVar![1]}\\b`, "g"))!.length,
        `${entity}: ${okVar![1]} is assigned but never read — the failure never reaches the render`,
      ).toBeGreaterThan(1)
      // ⚠ AND THE TWO MUST BE THE SAME BRANCH. 🚨 Without this the guard MISSED
      // a real mutation: swapping `{editionsOk ? (<grid/>) : (<SectionUnavailable/>)`
      // for `{true ? …` leaves BOTH the identifier (it is used elsewhere on the
      // page) and the literal `<SectionUnavailable` (now an unreachable branch)
      // in the source, so every check above still passed while the page rendered
      // an empty grid out of a failed read. Presence of a component is not
      // evidence it is reached — mutation is the only thing that says so.
      expect(
        code,
        `${entity}: <SectionUnavailable> is in the file but not on a branch of ${okVar![1]} — a failed read would render the structural section EMPTY`,
      ).toMatch(new RegExp(`\\{\\s*!?${okVar![1]}\\s*(\\?|&&)[\\s\\S]{0,600}?<SectionUnavailable`))

      // Rung 3 does not repeal the DETAIL read's bound: that one has no page
      // left to degrade, so it still returns the whole-page view.
      expect(code, `${entity} must still define its <Entity>Unavailable for the DETAIL read`).toMatch(
        /function \w*Unavailable\(/,
      )
      expect(code, `${entity}: the detail read no longer returns a whole-page *Unavailable`).toMatch(
        /return <\w*Unavailable/,
      )
    },
  )

  // ── The machine-readable half ───────────────────────────────────────────
  // `collectionEntityJsonLd` publishes `numberOfItems: items.length`. Emitted
  // off a failed structural read it tells a crawler a 4,895-edition series holds
  // none — the fabricated-number shape, in the one place no human proof-reads
  // it. Omitting the script is the honest outcome: no claim beats a false one.
  const jsonLd = structural.filter(({ src }) => stripComments(src).includes("collectionEntityJsonLd({"))

  it("found the pages that publish an ItemList", () => {
    expect(
      jsonLd.length,
      "no entity page calls collectionEntityJsonLd — renamed, or the walk is wrong",
    ).toBeGreaterThanOrEqual(2)
  })

  it.each(jsonLd.map((p) => [p.entity, p.src] as const))(
    "%s withholds its ItemList JSON-LD when the structural read failed",
    (entity: string, src: string) => {
      const code = stripComments(src)
      const okVar = code.match(/\b(\w+Ok) = \w+\.ok\b/)![1]
      const at = code.indexOf("collectionEntityJsonLd({")
      // The gate sits on the enclosing `{ok && (<script …>)}`, just above.
      const before = code.slice(Math.max(0, at - 400), at)
      expect(
        before,
        `${entity}: the JSON-LD <script> is not gated on ${okVar} — it would publish numberOfItems: 0 out of a failed read`,
      ).toMatch(new RegExp(`\\{\\s*${okVar}\\s*&&`))
    },
  )
})

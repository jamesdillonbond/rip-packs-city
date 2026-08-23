// Every entity page with a STRUCTURAL section read must catch it and degrade in
// brand — not fall through to the segment error boundary.
//
// ── THE DISTINCTION, because it is easy to read this as already-solved ──────
// `lib/entity-section-rpc.ts` marks some section reads `structural: true`: those
// THROW after retries rather than render a real entity with a convincingly empty
// catalogue. That throw is correct. What each page owes is a CATCHER.
//
// ⚠ `app/(collections)/[collection]/error.tsx` (R19, 2026-08-23) already catches
// these IN BRAND, so an uncaught throw is no longer the unbranded Next 500 that
// finding described. **This guard is about what the reader KEEPS.** The boundary
// replaces the whole page with a generic "couldn't render this page"; a page's
// own `*Unavailable` names the entity and offers a relevant way onward. Three of
// the four pages did the second; `series` did the first, which is the
// "three-plus-one" state that makes a class look handled when it is not.
//
// ⚠ DERIVED FROM THE TREE, NOT A LIST. The population is every
// `[collection]/*/[slug]/page.tsx` that contains a `structural: true` read, so a
// fifth entity page added tomorrow is inside this check by construction rather
// than by someone remembering to add it. A curated list drifts — this repo has
// recorded that twice.
//
// ⚠ Per-SECTION degradation still beats whole-page and is still filed. This
// guard pins the rung the pages are actually on, not the one they should reach.

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

describe("structural entity reads degrade in brand", () => {
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
    "%s routes its structural read into a branded *Unavailable",
    (entity: string, src: string) => {
      const code = stripComments(src)

      // The page must define its own branded degraded view...
      expect(code, `${entity} must define an <Entity>Unavailable component`).toMatch(
        /function \w*Unavailable\(/,
      )

      // ...and the catch that returns it must be the one guarding the STRUCTURAL
      // READ, which is why this locates the fetcher and works forward from its
      // CALL SITE rather than looking for any catch anywhere in the file.
      //
      // 🚨 AN EARLIER DRAFT OF THIS ASSERTION WAS VACUOUS AND I ONLY FOUND OUT BY
      // MUTATING. It matched `catch … return <…Unavailable` anywhere, and every
      // one of these pages has a SECOND, unrelated catch around its DETAIL read
      // that returns the same component — so reverting the series fix still
      // passed. The comment above it claimed it would not. **A guard that names
      // the defect it prevents and then matches something weaker is the shape
      // this repo keeps recording, and prose is no defence against it.**
      // ⚠ `[\s\S]{0,400}?` and NOT `[^}]*`: the fetcher's body passes an ARGS
      // OBJECT before the options object, so there is a `}` between the function
      // brace and `structural: true`. The first draft used `[^}]*` and matched
      // nothing on all four pages.
      const declaration = new RegExp(
        `async function (\\w+)\\([^)]*\\)[^{]*\\{[\\s\\S]{0,400}?structural: true`,
      )
      const declared = code.match(declaration)
      expect(declared, `${entity}: could not locate the structural fetcher`).not.toBeNull()
      const fetcher = declared![1]

      // The call site is the occurrence that is NOT the declaration.
      const callSites = [...code.matchAll(new RegExp(`\\b${fetcher}\\(`, "g"))]
        .map((m) => m.index!)
        .filter((i) => !code.slice(Math.max(0, i - 20), i).includes("function "))
      expect(callSites.length, `${entity}: ${fetcher} is declared but never called`).toBeGreaterThan(0)

      for (const at of callSites) {
        // ⚠ A tight window on purpose. Allowing "somewhere later in the file"
        // is how the vacuous version passed: these files are 300-400 lines and
        // a distant catch says nothing about this read.
        const after = code.slice(at, at + 600)
        expect(
          after,
          `${entity}: the ${fetcher}() call is not inside a try whose catch returns an Unavailable view`,
        ).toMatch(/\}\s*catch[^)]*\{[\s\S]{0,200}?return <\w*Unavailable/)
      }
    },
  )
})

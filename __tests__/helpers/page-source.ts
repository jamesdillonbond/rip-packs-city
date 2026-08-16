import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"

// Reads "the page" as the unit a SOURCE GUARD is actually asserting about.
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
//
// A `"use client"` `page.tsx` is progressively being split into a thin server
// shell plus a sibling `*Client.tsx`, so the component coverage gate (whose
// include is `app/**/*Client.tsx`) can measure it. That conversion moves the
// logic a source guard greps for from one file to another WITH NO BEHAVIOUR
// CHANGE.
//
// A guard hard-coded to `page.tsx` therefore goes red on a pure refactor. That
// happened on 2026-08-16: the `*Client.tsx` workstream reddened 14 assertions
// across three guard files while every property they assert was intact and had
// simply moved (`MarketplaceStatusBanner` 2 hits in `CollectionOverviewClient.tsx`
// vs 0 in `page.tsx`; `loadFailed` 4 vs 1; `walletsFailed` 3 vs 1).
//
// ⚠ THE DANGER IS THE REPAIR, NOT THE BREAKAGE. A red guard whose subject has
// merely moved invites the "fix" of loosening or deleting the assertion — at
// which point the conversion has silently bought COVERAGE LOSS on exactly the
// honesty properties these guards exist to hold. Reading both files keeps the
// assertion at full strength and makes the next conversion a no-op here.
//
// This is the guard-scope class met from a new direction: elsewhere in this repo
// a guard is blind because its own predicate fixes its SCOPE; here it is blind
// because its TARGET moved out from under a hard-coded path.
//
// ── SEMANTICS ───────────────────────────────────────────────────────────────
//
// `page.tsx` is REQUIRED (a missing one is a real error, not an empty string —
// otherwise every assertion silently passes against nothing). Sibling
// `*Client.tsx` files are optional and sorted for determinism.
//
// ⚠ Concatenation makes `toContain` satisfied by EITHER file, which is what
// "the page contains this" should mean, and makes `not.toContain` require it of
// BOTH — strictly stronger, never weaker. But index-ordering assertions
// (`a.indexOf(x) < a.indexOf(y)`) are only meaningful when x and y live in the
// SAME file; across the boundary the order is just concatenation order. Every
// current ordering assertion is within one file. If you add one that spans the
// shell and the client, read the single file you mean instead.

/** Absolute paths that together constitute the page: `page.tsx` + sibling `*Client.tsx`. */
export function pageSourceFiles(dirAbs: string): string[] {
  const page = join(dirAbs, "page.tsx")
  if (!existsSync(page)) throw new Error(`missing page source at ${page}`)
  const clients = readdirSync(dirAbs)
    .filter((f) => f.endsWith("Client.tsx"))
    .sort()
    .map((f) => join(dirAbs, f))
  return [page, ...clients]
}

/**
 * Concatenated source of a page directory. Pass the DIRECTORY, not the file, so
 * the guard keeps working whether or not that page has been split yet.
 */
export function pageSource(...dirParts: string[]): string {
  const dirAbs = join(process.cwd(), ...dirParts)
  return pageSourceFiles(dirAbs)
    .map((f) => readFileSync(f, "utf8"))
    .join("\n")
}

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

// ── A META-GUARD FOR THIS CLASS WAS PROTOTYPED, MEASURED AND REJECTED ───────
//
// The obvious next step is a guard that fails any test hard-coding an
// `app/**/page.tsx` whose directory also holds a `*Client.tsx`. It was built and
// run: it produces FALSE POSITIVES and would have made three correct guards
// wrong.
//
// `[collection]/pack/[id]/` contains `PackLifecycleClient.tsx`, but that page was
// never converted — it is a SERVER page that still holds all of its own logic
// (generateMetadata, its own reads) and imports client SUBCOMPONENTS as children.
// Routing `metadata-catch-branch-is-not-a-404`,
// `metadata-failed-read-vs-absent-guard` and `server-pages-error-vs-absent-guard`
// through `pageSource` would concatenate an unrelated client child into their
// source, changing what their `not.toContain` assertions even mean.
//
// "Directory has a *Client.tsx" does not imply "this page was split", and the
// difference is not decidable from the file layout — same shape as the rejected
// OG headline-count guard, where the defect was not decidable from the card's own
// source. Do not rebuild it.
//
// What makes that acceptable: for a PRESENCE assertion the stale path fails LOUD
// (red CI, which is how this class was found). The genuinely silent case is an
// ABSENCE assertion on a client page, which would pass vacuously against a thin
// shell — that population was swept on 2026-08-16 and is fully routed through
// this helper. Re-run the sweep if you add one:
//   grep for `.not.toContain(` / `.not.toMatch(` in a test that reads a
//   `"use client"` page.tsx, and route it through `pageSource`/`readSite`.

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

/**
 * Reads one repo-relative SITE, where a site is whatever a guard asserts about:
 * a `page.tsx` is read as the page unit (shell + sibling `*Client.tsx`), and
 * anything else — a component, a `route.tsx`, an already-extracted `*Client.tsx`
 * — is read as the single file it is.
 *
 * Exists because guards routinely hold a MIXED list (`profile-default-avatar`
 * checks a client component, a collection page, an OG route and a preview
 * component in one array). Without this, the `page.tsx` entry in such a list is
 * the one that silently stops covering anything the day that page is split.
 */
export function readSite(rel: string): string {
  const abs = join(process.cwd(), rel)
  if (rel.endsWith("page.tsx")) return pageSource(rel.slice(0, -"page.tsx".length))
  return readFileSync(abs, "utf8")
}

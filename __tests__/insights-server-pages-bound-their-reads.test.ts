import { describe, it, expect } from "vitest"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

// Every PRERENDERED `/insights` server page must bound its data read.
//
// ── THE INCIDENT ───────────────────────────────────────────────────────────
// Two production deploys ERRORed on 2026-08-15 within ten minutes —
// `/insights/market` and `/insights/market-pulse`, a DIFFERENT page each time,
// neither touched by the commit that failed (one was tests-only) — both on
// "Timed out acquiring connection from connection pool" ending in "Export
// encountered an error … exiting the build".
//
// Next gives each prerendered page 60s to export, retries 3×, then kills the
// whole build. So an unbounded board read is not a slow page, it is a coin flip
// on every deploy, resolved by whichever board the saturation happens to land
// on. Measured at the time: only 5 of 30 pages bounded anything.
//
// ── WHY A BAN AND NOT A RATCHET ────────────────────────────────────────────
// The repo's usual answer to a large pre-existing population is a ratchet,
// because a ban would ship a 30-entry allowlist. Here the population was driven
// to ZERO in the same pass, so a ban carries no allowlist and no exceptions —
// it is enforceable rather than theatre. If a page ever needs a genuine
// exemption, that is a deliberate decision to argue for, not a default.
//
// ── THIS IS THE THIRD INSTANCE OF ONE CLASS ────────────────────────────────
// `BOARD_LIVE_TIMEOUT_MS` was created for it on first-mint; `SET_DETAIL_TIMEOUT_MS`
// fixed it on `/analytics/sets`. Both prior fixes were applied to the ONE page
// that failed rather than to the shape, which is exactly why it came back twice.
// This test is the shape-level fix.

const INSIGHTS_DIR = join(process.cwd(), "app", "insights")
const USE_CLIENT = /^\s*["']use client["']/

/** Any of the sanctioned bounded paths.
 *
 * ⚠ The `(?:<[^>]*>)?` is load-bearing, not defensive: most call sites supply an
 * explicit type argument (`fetchBoardForPage<MarketPulseRow[]>(...)`), so a
 * plain `name\s*\(` matched NONE of the eight pages that route through the
 * shared fetcher. The first version of this guard did exactly that and reported
 * nine correctly-bounded pages as offenders. */
const BOUNDED = [
  // The board snapshot ladder — bounds internally via BOARD_LIVE_TIMEOUT_MS.
  /readBoardOrLive\s*(?:<[^>]*>)?\s*\(/,
  // The shared page fetcher — bounds internally.
  /fetchBoardForPage\s*(?:<[^>]*>)?\s*\(/,
  // The two explicit primitives, for pages with their own fetch shape.
  /withBoardBudget\s*(?:<[^>]*>)?\s*\(/,
  /withPagedBoardBudget\s*(?:<[^>]*>)?\s*\(/,
]

/**
 * ⚠ COMMENTS ARE STRIPPED BEFORE ANY MATCH, and this is not tidiness — the
 * guards-the-guard case below caught it live. `lib/insights/board-status.ts`
 * mentions `readBoardOrLive()` twice in its PROSE, so following a page's imports
 * without stripping meant any page importing `board-status` was declared bounded
 * by a comment. The original page-level check had the same hole: a page whose
 * header explained why it uses `withBoardBudget` would pass without calling it.
 * Newlines are preserved so nothing downstream shifts.
 *
 * This is the repo's recurring trap — any check that greps source for a token
 * must strip comments first, including the one you are extending.
 */
/*
 * ⚠ MIGRATED 2026-08-22 to the ONE shared stripper (scripts/lib/strip-comments.mjs).
 * The local copy stripped BLOCK comments before LINE comments, so an ordinary
 * line comment mentioning a glob path opened a block comment running to the next
 * close-comment anywhere in the file, blanking real source this guard then
 * reported as clean (103,590 chars across 49 product files). The shared version
 * blanks rather than deletes, so offsets and line numbers survive.
 * Do not re-inline a local copy.
 */

/** A direct DB call in the page itself. */
const DIRECT_QUERY = /\.from\s*\(|\.rpc\s*(?:as any\))?\s*\(/

/**
 * ⚠ REPOINTED 2026-08-15, and the reason is a genuine TENSION BETWEEN TWO GUARDS
 * that anyone extracting a page will hit.
 *
 * `server-page-data-access-ratchet` pushes a page's data access DOWN into
 * `lib/`, and the only way to drop a page off it is for the page to stop
 * importing a Supabase client at all. But this guard read the PAGE source for a
 * budget primitive — so the moment a page was correctly extracted, the primitive
 * moved into the lib module and this guard called the page unbounded. Two
 * correct changes could not both be satisfied.
 *
 * The fix follows ONE level of delegation, and deliberately not more:
 *   • a page that still holds its own `.from(` / `.rpc(` must name a budget
 *     primitive ITSELF — unchanged, because that read is in the page;
 *   • a page with NO direct query may satisfy the bound from a `@/lib/insights/*`
 *     module it actually imports.
 *
 * ⚠ That pairing is what stops this from being a weakening. A page cannot pass
 * by importing a bounded module while doing an unbounded read of its own, and
 * only modules the page genuinely imports are consulted — not any bounded file
 * that happens to exist. Same repointing move as
 * `pack-dist-contents-not-streamed`: the guard was pinning WHERE the primitive
 * appears, when the property is that the read is bounded.
 */
function importedInsightsLibs(src: string): string[] {
  const out: string[] = []
  const re = /from\s+["']@\/(lib\/insights\/[A-Za-z0-9._/-]+)["']/g
  for (const m of src.matchAll(re)) {
    for (const ext of [".ts", ".tsx"]) {
      const file = join(process.cwd(), m[1] + ext)
      try {
        out.push(readFileSync(file, "utf8"))
        break
      } catch {
        /* try the next extension */
      }
    }
  }
  return out
}

/** Does this page bound its read, directly or through a lib module it imports? */
function isBounded(raw: string): boolean {
  const src = stripComments(raw)
  if (BOUNDED.some((re) => re.test(src))) return true
  // A page that still queries directly must bound that read itself.
  if (DIRECT_QUERY.test(src)) return false
  return importedInsightsLibs(src).some((lib) =>
    BOUNDED.some((re) => re.test(stripComments(lib))),
  )
}

/** Async server pages under app/insights — the ones Next prerenders with a read.
 *
 * ⚠ THE HUB IS INCLUDED VIA ".", AND IT WAS THE HOLE. This walk used to iterate
 * subdirectories only, so `app/insights/page.tsx` — a FILE in INSIGHTS_DIR, not
 * a directory — was outside the guard BY CONSTRUCTION. It was also the only
 * unbounded read left on the surface, and on 2026-08-21T01:19Z it failed a
 * PRODUCTION BUILD: every board page logged a clean "read exceeded 8000ms" and
 * fell back, while /insights sat on an unbounded service-role RPC through three
 * 60 s export attempts and took the whole build down. Third instance of the
 * class this ban was written for, on the one page it could not see.
 *
 * "." is the entry name because `join(INSIGHTS_DIR, ".", "page.tsx")` resolves
 * to the hub with no change at any consumption site below. */
function asyncServerPages(): string[] {
  const out: string[] = []
  for (const entry of [".", ...readdirSync(INSIGHTS_DIR)]) {
    const dir = join(INSIGHTS_DIR, entry)
    if (!statSync(dir).isDirectory()) continue // "." is a directory, so the hub survives this
    const file = join(dir, "page.tsx")
    let src: string
    try {
      src = readFileSync(file, "utf8")
    } catch {
      continue
    }
    // Client pages do their reads in the browser — no export budget to blow.
    if (USE_CLIENT.test(src.split("\n").slice(0, 3).join("\n"))) continue
    // A synchronous server page is a static shell with no read to bound
    // (`account-value` is one). `export default async function` is the tell.
    if (!/export default async function/.test(src)) continue
    out.push(entry)
  }
  return out.sort()
}

describe("/insights server pages bound their reads", () => {
  const pages = asyncServerPages()

  it("is not vacuous: it found the prerendered board pages", () => {
    expect(pages.length).toBeGreaterThanOrEqual(20)
    // The pages that actually broke production builds, named so a rename cannot
    // silently drop any out of the checked set. "." is the hub — the 2026-08-21
    // failure — and naming it here is what stops the walk quietly reverting to
    // subdirectories-only.
    expect(pages).toContain("market")
    expect(pages).toContain("market-pulse")
    expect(pages, "the /insights HUB must be in scope, not just the board pages").toContain(".")
  })

  it("excludes client pages and static shells rather than exempting them", () => {
    // These are OUT of scope for a real reason, not allowlisted: a client page
    // reads in the browser, and a synchronous server page has no read at all.
    // Asserted so the exclusion stays a property rather than becoming a place to
    // hide an unbounded page by adding "use client" to the top.
    for (const clientPage of ["squeeze-check", "tc-report", "pack-reality"]) {
      const src = readFileSync(join(INSIGHTS_DIR, clientPage, "page.tsx"), "utf8")
      expect(USE_CLIENT.test(src.split("\n").slice(0, 3).join("\n"))).toBe(true)
    }
    const shell = readFileSync(join(INSIGHTS_DIR, "account-value", "page.tsx"), "utf8")
    expect(shell).not.toMatch(/export default async function/)
    expect(shell).not.toMatch(/supabaseAdmin/)
  })

  it.each(asyncServerPages())("/insights/%s bounds its read", (page) => {
    const src = readFileSync(join(INSIGHTS_DIR, page, "page.tsx"), "utf8")
    expect(
      isBounded(src),
      `/insights/${page} reads the DB during a PRERENDER without a budget.\n` +
        `Next kills the whole build if any page exceeds 60s, so this is a build-\n` +
        `integrity defect, not a slow page. Use one of:\n` +
        `  readBoardOrLive(...)        — the cached-board ladder\n` +
        `  fetchBoardForPage(...)      — the shared page fetcher\n` +
        `  withBoardBudget(p, label)   — rejects; for a page with a try/catch\n` +
        `  withPagedBoardBudget(p, l)  — resolves { rows, error }; for fetchAllPaged\n` +
        `...or move the read into a lib/insights/* module that uses one of the above,\n` +
        `which is what the server-page data-access ratchet is pushing you toward.`,
    ).toBe(true)
  })

  // ⚠ GUARDS THE GUARD. A check that follows delegation can go vacuous in a way
  // the direct version could not: if `isBounded` ever returned true for anything
  // that merely LOOKS delegated, every page would pass and the ban would be
  // decoration. These four cases pin the exact shape of the concession.
  it("the delegation concession is narrow: a page with its OWN query must still bound it", () => {
    const pageWithOwnQuery = [
      `import { fetchThing } from "@/lib/insights/board-page-fetch"`,
      `import { supabaseAdmin } from "@/lib/supabase"`,
      `export default async function P() {`,
      `  const { data } = await supabaseAdmin.from("v_thing").select("*")`,
      `  return null`,
      `}`,
    ].join("\n")
    // It imports a module that IS bounded — and is still rejected, because the
    // unbounded read is in the page.
    expect(isBounded(pageWithOwnQuery)).toBe(false)

    // The same page, with its own budget, passes.
    expect(isBounded(pageWithOwnQuery.replace("await supabaseAdmin", "await withBoardBudget(supabaseAdmin"))).toBe(true)

    // A fully extracted page — no query of its own — passes on its lib module.
    expect(
      isBounded(
        [
          `import { fetchPackMarketBuckets } from "@/lib/insights/pack-market-board"`,
          `export default async function P() { await fetchPackMarketBuckets("allday"); return null }`,
        ].join("\n"),
      ),
    ).toBe(true)

    // ⚠ A page with no query and no bounded import is NOT waved through — and
    // this exact case is what caught the comment hole: board-status.ts mentions
    // `readBoardOrLive()` twice in its prose, so before comments were stripped
    // this returned TRUE and any page importing it was "bounded" by a comment.
    expect(
      isBounded(
        [
          `import { boardStatus } from "@/lib/insights/board-status"`,
          `export default async function P() { return null }`,
        ].join("\n"),
      ),
    ).toBe(false)

    // ...and the page-level half of the same hole: naming a primitive in a
    // COMMENT does not bound anything.
    expect(
      isBounded(
        [
          `// This page uses withBoardBudget(...) — or rather, it does not.`,
          `import { supabaseAdmin } from "@/lib/supabase"`,
          `export default async function P() {`,
          `  await supabaseAdmin.from("v_thing").select("*")`,
          `  return null`,
          `}`,
        ].join("\n"),
      ),
    ).toBe(false)
  })

  it("no page is left unbounded — the count is zero, so there is no allowlist", () => {
    const unbounded = pages.filter((page) => {
      const src = readFileSync(join(INSIGHTS_DIR, page, "page.tsx"), "utf8")
      return !isBounded(src)
    })
    expect(unbounded, `unbounded: ${unbounded.join(", ")}`).toEqual([])
  })
})

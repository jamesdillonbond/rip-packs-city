// The coverage gates' INCLUDE globs, checked against the tree they claim to measure.
//
// ── THE HOLE THIS CLOSES, and it is the direction nobody watches ─────────────
// Three gates ratchet a coverage PERCENTAGE (`vitest.config.ts`,
// `vitest.components.config.ts`, `vitest.workers.config.ts`). A percentage is a
// ratio, and every existing guard watches the numerator: the thresholds red when
// coverage DROPS, `coverage-gates-are-wired-to-ci.test.ts` checks the gates run
// in CI, and `component-gate-include-completeness.test.ts` checks that no new
// `components/` subtree is silently ungated.
//
// 🚨 **Nothing watches the DENOMINATOR.** Narrowing `lib/**/*.ts` to
// `lib/analytics/**`, or deleting `app/**/route.ts` from the include array,
// removes hundreds of files from the measurement — and because the remaining
// files are the well-tested ones, **the coverage percentage goes UP and every
// threshold passes**. The gate reports a better number for measuring less. That
// is this repo's most-feared shape (a guard that inspected nothing, reading as a
// pass) applied to the coverage gates themselves.
//
// ⚠ **Deliberately expressed over the TREE, not over a count.** An earlier cut
// asserted "the primary gate matches at least N files", which reds the day
// somebody legitimately deletes N+1 files — a ceiling that churns gets raised
// rather than read. The property here is *every file of this shape is matched*,
// which is invariant under ordinary additions and deletions and reds only when
// the globs themselves stop covering a surface.
//
// ⚠ **The globs are READ FROM THE CONFIGS, never restated here.** A copy would
// be a claim about the configs that can go stale silently — the exact failure
// this file exists to prevent, one level up.

import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join, relative, sep } from "node:path"
import { stripComments } from "../scripts/lib/strip-comments.mjs"
import { walkRepoSourceTree } from "./helpers/source-files"

const ROOT = process.cwd()
const rel = (f: string) => relative(ROOT, f).split(sep).join("/")

/**
 * The `coverage.include` array of a vitest config, as the config actually states it.
 *
 * ⚠ Comments are stripped first, with the shared helper. A commented-out glob
 * must NOT count as coverage — that is precisely how a subtree leaves the
 * measurement while the file still appears to name it.
 */
function coverageIncludes(configFile: string): string[] {
  const src = stripComments(readFileSync(join(ROOT, configFile), "utf8"))
  const m = src.match(/coverage\s*:\s*\{[\s\S]*?include\s*:\s*\[([\s\S]*?)\]/)
  if (!m) return []
  return [...m[1].matchAll(/["']([^"']+)["']/g)].map((x) => x[1])
}

/**
 * Minimal glob matcher for the two forms these configs use: `**` (any depth,
 * possibly none) and `*` (one segment, no slash).
 *
 * ⚠ Its correctness is PINNED below rather than assumed. A matcher that silently
 * matched everything would make every assertion in this file vacuous while
 * reporting perfect coverage of the tree — so it gets both controls.
 */
const GS_SLASH = "@@GLOBSTAR_SLASH@@"
const GS = "@@GLOBSTAR@@"
export function globToRegExp(glob: string): RegExp {
  const body = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\//g, GS_SLASH)
    .replace(/\*\*/g, GS)
    .replace(/\*/g, "[^/]*")
    .split(GS_SLASH)
    .join("(?:.*/)?")
    .split(GS)
    .join(".*")
  return new RegExp("^" + body + "$")
}

const matchesAny = (path: string, globs: string[]) =>
  globs.some((g) => globToRegExp(g).test(path))

const SOURCE_ROOTS = ["app", "lib", "components", "workers"]
const allSource = walkRepoSourceTree(ROOT)
  .map(rel)
  .filter((p) => SOURCE_ROOTS.some((r) => p === r || p.startsWith(r + "/")))
  .filter((p) => !/\.d\.ts$/.test(p) && !/\.test\.tsx?$/.test(p))

describe("the coverage gates still measure what their includes claim", () => {
  const primary = coverageIncludes("vitest.config.ts")
  const components = coverageIncludes("vitest.components.config.ts")
  const workers = coverageIncludes("vitest.workers.config.ts")

  it("each config yielded a non-empty include list", () => {
    // ⚠ THE VACUITY GUARD. If the parse returns [] — a reformat, a rename of the
    // `coverage` key, a move to a shared config — then `matchesAny` is false for
    // everything and the bans below would red loudly rather than pass silently.
    // This assertion is what names the CAUSE as "the parse broke" instead of
    // sending the next reader to look for a deleted glob.
    expect(primary.length, "vitest.config.ts coverage.include did not parse").toBeGreaterThan(3)
    expect(components.length, "vitest.components.config.ts coverage.include did not parse").toBeGreaterThan(3)
    expect(workers.length, "vitest.workers.config.ts coverage.include did not parse").toBeGreaterThan(0)
  })

  it("inspected a non-trivial slice of the tree", () => {
    // A walk that silently matched nothing exits clean and reads as coverage.
    expect(allSource.length).toBeGreaterThan(700)
  })

  it("MATCHER CONTROL — the glob translation discriminates", () => {
    // Positive: the shapes these configs actually use.
    expect(globToRegExp("lib/**/*.ts").test("lib/a/b/c.ts")).toBe(true)
    expect(globToRegExp("lib/**/*.ts").test("lib/c.ts")).toBe(true) // `**/` may match nothing
    expect(globToRegExp("app/**/route.ts").test("app/api/x/route.ts")).toBe(true)
    expect(globToRegExp("components/*.tsx").test("components/Foo.tsx")).toBe(true)
    // Negative: `*` must not cross a slash, and the suffix must hold. Without
    // these a permissive matcher would call the whole tree measured.
    expect(globToRegExp("components/*.tsx").test("components/ui/Foo.tsx")).toBe(false)
    expect(globToRegExp("lib/**/*.ts").test("lib/a/b/c.tsx")).toBe(false)
    expect(globToRegExp("app/**/route.ts").test("app/api/x/page.tsx")).toBe(false)
  })

  it("BAN AT ZERO — every lib/ module is still in the primary gate", () => {
    const unmatched = allSource
      .filter((p) => p.startsWith("lib/") && /\.tsx?$/.test(p))
      .filter((p) => !matchesAny(p, primary))
    expect(
      unmatched,
      "lib/ files no longer matched by vitest.config.ts coverage.include.\n" +
        "Narrowing an include REMOVES files from the denominator, so coverage goes\n" +
        "UP and every threshold still passes. Restore the glob rather than the number.\n" +
        unmatched.slice(0, 20).map((p) => "  " + p).join("\n"),
    ).toEqual([])
  })

  it("BAN AT ZERO — every API route is still in the primary gate", () => {
    const unmatched = allSource
      .filter((p) => /(^|\/)route\.tsx?$/.test(p) && p.startsWith("app/"))
      .filter((p) => !matchesAny(p, primary))
    expect(
      unmatched,
      "app/**/route.ts files no longer matched by the primary gate.\n" +
        "Every API route a user can reach is supposed to be measured here.\n" +
        unmatched.slice(0, 20).map((p) => "  " + p).join("\n"),
    ).toEqual([])
  })

  it("BAN AT ZERO — every worker is still in the workers gate", () => {
    const unmatched = allSource
      .filter((p) => p.startsWith("workers/") && /\.(ts|js)$/.test(p))
      .filter((p) => !matchesAny(p, workers))
    expect(
      unmatched,
      "workers/ files no longer matched by vitest.workers.config.ts.\n" +
        unmatched.slice(0, 20).map((p) => "  " + p).join("\n"),
    ).toEqual([])
  })

  it("BAN AT ZERO — every *Client.tsx is still in the component gate", () => {
    // The client dashboards. `app/**/*Client.tsx` is a single glob carrying 61+
    // files; deleting that one line would silently unmeasure all of them.
    const unmatched = allSource
      .filter((p) => /Client\.tsx$/.test(p) && p.startsWith("app/"))
      .filter((p) => !matchesAny(p, components))
    expect(
      unmatched,
      "app/**/*Client.tsx files no longer matched by the component gate.\n" +
        unmatched.slice(0, 20).map((p) => "  " + p).join("\n"),
    ).toEqual([])
  })

  it("POSITIVE CONTROL — a narrowed include is CAUGHT", () => {
    // Without this, the four bans above would pass identically against a matcher
    // that returns true for everything. This proves they can fail.
    const narrowed = ["lib/analytics/**/*.ts"]
    const unmatched = allSource
      .filter((p) => p.startsWith("lib/") && /\.tsx?$/.test(p))
      .filter((p) => !matchesAny(p, narrowed))
    expect(unmatched.length).toBeGreaterThan(100)
  })

  it("POSITIVE CONTROL — a COMMENTED-OUT glob does not count as coverage", () => {
    // The subtle way an include dies: it is still visible in the file, so a
    // reviewer skimming the config sees the surface named. Comments are stripped
    // before the array is read, so this is measured rather than assumed.
    const withComment = stripComments(
      ['export default { test: { coverage: { include: [', '  // "lib/**/*.ts",', '  "app/**/route.ts",', '] } } }'].join("\n"),
    )
    const globs = [...withComment.match(/include\s*:\s*\[([\s\S]*?)\]/)![1].matchAll(/["']([^"']+)["']/g)].map((x) => x[1])
    expect(globs).toEqual(["app/**/route.ts"])
  })
})

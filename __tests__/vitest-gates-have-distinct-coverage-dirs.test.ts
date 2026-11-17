import { describe, it, expect } from "vitest"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

// BAN: two vitest gates must not share a coverage.reportsDirectory.
//
// ── THE DEFECT THIS EXISTS FOR (measured 2026-08-17) ──────────────────────
// `.gitignore` has carried this invariant in prose since it was written —
// "the two gates (primary + components) must run into SEPARATE
// reportsDirectory dirs or they corrupt each other's coverage/.tmp" — and NO
// config implemented it. All three defaulted to `coverage/`.
//
// Reproduced by running the primary and component gates concurrently. Both
// exited 1, by two DIFFERENT routes, and the second is why this is a guard and
// not a comment:
//   * primary died loudly and correctly — "Something removed the coverage
//     directory ... Make sure you are not running multiple Vitests with the
//     same coverage.reportsDirectory at the same time".
//   * ⚠ THE COMPONENT GATE DID NOT CRASH. It lost the deleted `.tmp` chunks and
//     published what survived as a MEASURED RESULT: 82.27 st / 73.80 br /
//     80.61 fn / 85.01 ln, against true values of 90.68 / 81.87 / 89.25 /
//     93.60 — an ~8-point fabricated regression, reported as a THRESHOLD
//     FAILURE. It reads as "your diff broke coverage" and names the author's
//     own work as the culprit.
//
// That second mode is this repo's own top defect class — a failed read
// rendered as an answer — sitting in the tooling rather than the product, and
// pointing at the wrong cause. CI is unaffected (separate jobs), so the cost
// lands entirely on local and agent runs, where it is indistinguishable from a
// real regression.
//
// ── WHY A GLOB AND NOT A LIST OF THREE ────────────────────────────────────
// A curated list of the three known configs would be silent by construction
// about a fourth, which is exactly how the guards fixed earlier tonight went
// green while blind. The set is DERIVED from the tree.

const ROOT = process.cwd()

function vitestConfigs(): string[] {
  return readdirSync(ROOT)
    .filter((f) => /^vitest(\..+)?\.config\.(ts|mts|js|mjs)$/.test(f))
    .sort()
}

/**
 * Read the declared reportsDirectory.
 *
 * ⚠ Comments are stripped first, offsets preserved. The configs' own comments
 * quote `coverage.reportsDirectory` while explaining the invariant, and this
 * repo has shipped a guard that reported its own documentation at least six
 * times.
 */
/*
 * ⚠ MIGRATED 2026-08-22 to the ONE shared stripper (scripts/lib/strip-comments.mjs).
 * The local copy here stripped BLOCK comments before LINE comments, so an
 * ordinary line comment mentioning a glob path opened a block comment that ran
 * to the next close-comment anywhere in the file, blanking real source this
 * guard then reported as clean (103,590 chars across 49 product files).
 * Do not re-inline a local copy.
 */

function reportsDirectoryOf(file: string): string | null {
  const src = stripComments(readFileSync(join(ROOT, file), "utf8"))
  return /reportsDirectory\s*:\s*["'`]([^"'`]+)["'`]/.exec(src)?.[1] ?? null
}

describe("vitest gates write coverage into distinct directories", () => {
  it("the glob still finds the gate configs (not vacuously passing)", () => {
    // ⚠ On the ENUMERATION, never on a violation count — the assertion has to
    // stay satisfiable when every config is correct, which is the goal state.
    const configs = vitestConfigs()
    expect(configs, "no vitest configs found — the glob is broken").not.toHaveLength(0)
    expect(configs.length).toBeGreaterThanOrEqual(3)
  })

  it("every gate DECLARES a reportsDirectory rather than defaulting", () => {
    // Defaulting is the defect: the default is the same `coverage/` for all of
    // them, so "no one set it" is precisely the collision.
    const missing = vitestConfigs().filter((f) => reportsDirectoryOf(f) === null)
    expect(
      missing.join(", "),
      "these vitest configs default to coverage/ and will corrupt each other's .tmp:\n  " + missing.join("\n  "),
    ).toBe("")
  })

  it("no two gates share a reportsDirectory", () => {
    const seen = new Map<string, string[]>()
    for (const f of vitestConfigs()) {
      const dir = reportsDirectoryOf(f)
      if (dir === null) continue
      seen.set(dir, [...(seen.get(dir) ?? []), f])
    }
    const collisions = [...seen.entries()].filter(([, files]) => files.length > 1)
    expect(
      collisions.map(([dir, files]) => dir + " <- " + files.join(" + ")).join("\n"),
      "shared coverage dirs — a concurrent run will publish fabricated coverage numbers",
    ).toBe("")
  })

  it("every declared directory is actually gitignored", () => {
    // A distinct directory that is not ignored trades a corrupt run for a
    // committed 40MB report, so the two halves have to hold together.
    const ignore = readFileSync(join(ROOT, ".gitignore"), "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"))
    const covered = (dir: string) =>
      ignore.some((pat) => {
        const p = pat.replace(/^\//, "").replace(/\/$/, "")
        if (p === dir) return true
        if (p.endsWith("*")) return dir.startsWith(p.slice(0, -1))
        return false
      })
    const uncovered = vitestConfigs()
      .map(reportsDirectoryOf)
      .filter((d): d is string => d !== null)
      .filter((d) => !covered(d))
    expect(uncovered.join(", "), "coverage output that would be committed: " + uncovered.join(", ")).toBe("")
  })

  // ── guards-the-guard ─────────────────────────────────────────────────────

  it("the extractor ignores a reportsDirectory that only appears in a COMMENT", () => {
    const commented = [
      '// reportsDirectory: "coverage-fake"',
      "export default { test: { coverage: { provider: 'v8' } } }",
    ].join("\n")
    expect(/reportsDirectory\s*:\s*["'`]([^"'`]+)["'`]/.exec(stripComments(commented))).toBeNull()
  })

  it("the extractor reads a real declaration", () => {
    const real = 'export default { test: { coverage: { reportsDirectory: "coverage-x" } } }'
    expect(/reportsDirectory\s*:\s*["'`]([^"'`]+)["'`]/.exec(stripComments(real))?.[1]).toBe("coverage-x")
  })
})

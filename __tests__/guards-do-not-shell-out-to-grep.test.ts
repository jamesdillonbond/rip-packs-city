import { describe, it, expect } from "vitest"
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { stripComments } from "../scripts/lib/strip-comments.mjs"
import { filesMatching, repoRelative, walkSourceFiles } from "./helpers/source-files"

// BAN AT ZERO — a guard must not discover its own population by shelling out to
// `grep`, and must not compare paths with `process.cwd() + "/"`.
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
// Both shapes are correct on the Linux CI runner and broken on Windows, which is
// the PRIMARY DEV MACHINE. Measured 2026-08-24: `npm test` reported 54 failures
// across 10 files on this box. NONE of them were real defects. Every one traced
// to one of these two shapes, and they failed in three different ways:
//
//   LOUD    metadata-catch-branch-is-not-a-404 — the grep pattern contains
//           SPACES, cmd.exe re-split it, execSync threw at module scope, the
//           suite reported "0 test". The guard was DEAD here and green in CI.
//   NOISY   entity-sections-do-not-conclude-from-a-failed-read — `rel()` used
//           `process.cwd() + "/"`, which never matches a backslash path, so the
//           curated SUPPRESSION list could not match and the guard reported its
//           own deliberately-suppressed entry as an offender.
//   SILENT  ⚠ THE ONE THAT MATTERS. `grep … || true` swallows the cmd.exe
//           failure into an EMPTY list. The guard then walks ZERO files and
//           PASSES. indexer-cursor-hold's `--include='*.ts'` sites had exactly
//           this shape: cmd.exe does not strip the quotes, so grep matched no
//           filename at all.
//
// ⚠ THE COST IS NOT THE FALSE REDS — IT IS WHAT THEY TRAIN. CLAUDE.md requires a
// full-suite run before every push. An instrument that is permanently red for
// environmental reasons is one a reader learns to skim, and a genuine failure
// hides in the noise. On 2026-08-24 exactly one of those 54 WAS real, and it was
// found only because the other 53 were traced to a cause first.
//
// ⚠ AND A GREEN CI IS NOT THE COUNTER-ARGUMENT. It is the other half of the
// finding: CI could not see any of this, because CI is the platform where the
// broken shape happens to work. "It passes in CI" is what let it accumulate.
//
// The replacement is `__tests__/helpers/source-files.ts`, which returns
// repo-relative forward-slash paths — byte-identical to what `grep -rl` returned
// on Linux, so a migrated guard's allowlists and ratchets need no edits. Parity
// verified at migration across all seven populations: 32 / 11 / 18 / 23 / 10 /
// 98 / 1, matching POSIX grep exactly.

/** Shelling out to a POSIX text tool to find files. */
const SHELLS_OUT = /\b(?:execSync|exec)\s*\(\s*[`"'][^`"']*\b(?:grep|find|rg|ls|sed|awk)\b/

/** The path comparison that silently never matches on Windows. */
const CWD_CONCAT = /process\.cwd\(\)\s*\+\s*["'`]\//

/**
 * ⚠ EXEMPT — and both exemptions are about the SHAPE, not about a file.
 *
 * `execFileSync(process.execPath, [...])` is fine: it takes an ARGV ARRAY, so no
 * shell parses it and there is nothing for cmd.exe to re-split. That is the
 * portable way to run one of this repo's own `scripts/*.mjs` guards from a test,
 * and driver-message-leak-guard uses it correctly.
 *
 * ⚠ This file is scanned too. It quotes both banned shapes in its own regexes
 * above, which is why every read below is stripped of comments AND why the
 * detector is proven against a fixture rather than against this file. Six guards
 * in this repo have already fired on the comment documenting their own fix.
 */
const GUARD_DIRS = ["__tests__", "scripts"]

/**
 * This file, repo-relative — DERIVED, never spelled out.
 *
 * ⚠ THE ONE EXCLUSION, and it is unavoidable: the "detectors actually fire"
 * block below must contain the banned shapes as STRING LITERALS to prove the
 * regexes are not vacuous, and a string literal survives comment-stripping.
 * Comment-stripping alone was tried first and this guard still reported itself
 * — the same self-report that has caught six other guards here, arriving via
 * fixtures rather than via prose.
 *
 * ⚠ Derived from import.meta.url rather than written as a path, because a guard
 * that NAMES its instances dies on a rename — three already have. Renaming this
 * file keeps the exclusion pointing at it.
 */
const SELF = repoRelative(fileURLToPath(import.meta.url))

// ⚠ MEMOISED. The walk covers ~1,400 files across two trees, and the first
// draft of the self-exclusion assertion below called it once PER FILE — an
// accidental O(n²) that took 71s and tripped the 5s timeout. Walk once.
let _guardFiles: string[] | null = null
function guardFiles(): string[] {
  if (!_guardFiles) {
    _guardFiles = GUARD_DIRS.flatMap((d) =>
      walkSourceFiles(d, (n) => n.endsWith(".ts") || n.endsWith(".mjs") || n.endsWith(".tsx")),
    ).map(repoRelative)
  }
  return _guardFiles
}

/** Scanned population: every guard file EXCEPT this one. */
function scanned(): string[] {
  return guardFiles().filter((f) => f !== SELF)
}

// ⚠ READ AND STRIP ONCE. Comments still have to go — several guards DOCUMENT
// the shape they migrated away from, and prose about a defect is not the defect
// — but stripping ~1,400 files is the expensive part.
//
// ⚠ The first draft called this per ARM and twice per assertion (once for the
// value, once to build the failure message): four full passes. Alone that was
// 2.7s; under the full `--coverage` run's parallel load it crossed the 5s
// timeout and this guard failed for being slow rather than for finding
// anything. A guard that reds under load is the same untrustworthy-instrument
// problem this file was written about.
let _stripped: Array<[string, string]> | null = null
function strippedSources(): Array<[string, string]> {
  if (!_stripped) {
    _stripped = scanned().map((f) => [f, stripComments(readFileSync(f, "utf8"))] as [string, string])
  }
  return _stripped
}

const _offenders = new Map<RegExp, string[]>()
function offenders(re: RegExp): string[] {
  let hit = _offenders.get(re)
  if (!hit) {
    hit = strippedSources()
      .filter(([, src]) => re.test(src))
      .map(([f]) => f)
      .sort()
    _offenders.set(re, hit)
  }
  return hit
}

describe("guards find their population in-process, not through a shell", () => {
  it("is not vacuous: it inspected the guard tree", () => {
    // ⚠ A ban-at-zero passes trivially if it read nothing, which is the very
    // failure mode this file exists to ban. Assert the COUNT INSPECTED.
    const files = scanned()
    expect(files.length).toBeGreaterThan(200)
    expect(files).toContain("scripts/check-driver-message-leaks.mjs")
    expect(files.some((f) => f.startsWith("__tests__/"))).toBe(true)
  }, 60_000)

  it("excludes ITSELF and nothing else, and would flag itself if it did not", () => {
    // ⚠ Assert the exclusion at the PROPERTY's granularity, not as a comment.
    // Exactly one file is dropped, it is this one, and it genuinely carries both
    // banned shapes — so the exclusion is load-bearing rather than decorative,
    // and widening it later cannot pass unnoticed.
    const kept = new Set(scanned())
    const dropped = guardFiles().filter((f) => !kept.has(f))
    expect(dropped).toEqual([SELF])
    expect(SELF.startsWith("__tests__/")).toBe(true)
    const own = stripComments(readFileSync(SELF, "utf8"))
    expect(SHELLS_OUT.test(own)).toBe(true)
    expect(CWD_CONCAT.test(own)).toBe(true)
  }, 60_000)

  it("NO guard shells out to grep/find to discover files", () => {
    expect(
      offenders(SHELLS_OUT).join("\n"),
      "these discover their population by shelling out to a POSIX text tool. That is " +
        "correct on the CI runner and broken on Windows — where, via `|| true`, it " +
        "yields an EMPTY population and the guard PASSES having inspected nothing. " +
        "Use filesMatching() from __tests__/helpers/source-files.ts:\n" +
        offenders(SHELLS_OUT).join("\n"),
    ).toBe("")
  }, 60_000)

  it("NO guard compares paths with process.cwd() + '/'", () => {
    expect(
      offenders(CWD_CONCAT).join("\n"),
      "these strip a repo prefix with `process.cwd() + \"/\"`, which never matches on " +
        "Windows because node:path.join yields backslashes — so the value silently " +
        "stays ABSOLUTE and any allowlist keyed on a relative path stops matching. " +
        "Use repoRelative() from __tests__/helpers/source-files.ts:\n" +
        offenders(CWD_CONCAT).join("\n"),
    ).toBe("")
  }, 60_000)

  it("the detectors actually fire on the shapes they ban", () => {
    // ⚠ Proven against a KNOWN OFFENDER, because a regex written into a heredoc
    // or mangled by an escape lands vacuous and reads as coverage. These are the
    // exact lines that were live in this repo before this commit.
    expect(SHELLS_OUT.test(`const r = execSync("grep -rl 'x' app || true")`)).toBe(true)
    expect(SHELLS_OUT.test("const r = execSync(`grep -rl 'x' app --include=route.ts`)")).toBe(true)
    expect(CWD_CONCAT.test(`f.replace(process.cwd() + "/", "")`)).toBe(true)

    // And do NOT fire on the portable shapes, or the ban would punish the fix.
    expect(SHELLS_OUT.test(`execFileSync(process.execPath, [SCRIPT, "--root", root])`)).toBe(false)
    expect(SHELLS_OUT.test(`filesMatching("app", (n) => n === "route.ts", "x")`)).toBe(false)
    expect(CWD_CONCAT.test(`relative(process.cwd(), abs).split(sep).join("/")`)).toBe(false)
  })
})

describe("filesMatching is the portable replacement", () => {
  /** A throwaway tree, so these assertions do not drift with the repo. */
  function fixture(): string {
    const dir = mkdtempSync(join(tmpdir(), "srcfiles-"))
    mkdirSync(join(dir, "a", "deep"), { recursive: true })
    writeFileSync(join(dir, "a", "route.ts"), "export const x = 1 // needle here\n")
    writeFileSync(join(dir, "a", "deep", "route.ts"), "no match in this one\n")
    writeFileSync(join(dir, "a", "deep", "other.ts"), "needle here but wrong filename\n")
    return dir
  }

  it("returns repo-relative FORWARD-SLASH paths, sorted", () => {
    // The contract the migrated guards depend on: their allowlists and exact-
    // equality ratchets are all written as "app/api/x/route.ts".
    const found = filesMatching("app/api", (n) => n === "route.ts", "firstFailedChunkStart")
    expect(found.length).toBeGreaterThan(0)
    for (const f of found) {
      expect(f).not.toMatch(/\\/)
      expect(f).not.toMatch(/^[A-Za-z]:/)
      expect(f.startsWith("app/api/")).toBe(true)
    }
    expect([...found].sort()).toEqual(found)
  })

  it("filters by BOTH filename and content, and recurses", () => {
    const dir = fixture()
    const cwd = process.cwd()
    try {
      process.chdir(dir)
      expect(filesMatching("a", (n) => n === "route.ts", "needle")).toEqual(["a/route.ts"])
      // Recursion reaches the nested dir; the nested route.ts simply lacks the needle.
      expect(filesMatching("a", (n) => n.endsWith(".ts"), "needle").sort()).toEqual([
        "a/deep/other.ts",
        "a/route.ts",
      ])
    } finally {
      process.chdir(cwd)
    }
  })

  it("a `g` regexp does not make the result depend on file ORDER", () => {
    // A global RegExp carries lastIndex between .test() calls, so the second
    // file tested would start mid-string and could be missed. That would be a
    // silently-undercounted population — this module's whole subject.
    const g = /firstFailedChunkStart/g
    const a = filesMatching("app/api", (n) => n === "route.ts", g)
    const b = filesMatching("app/api", (n) => n === "route.ts", g)
    expect(a.length).toBeGreaterThan(1)
    expect(a).toEqual(b)
    expect(a).toEqual(filesMatching("app/api", (n) => n === "route.ts", /firstFailedChunkStart/))
  })

  it("returns [] for a missing root — so the CALLER's floor is what catches it", () => {
    // Deliberate, and it mirrors `grep … || true`. The danger is documented in
    // the helper's header: an empty population must be caught by the caller's
    // not-vacuous assertion, never by this function throwing somewhere else.
    expect(filesMatching("no/such/dir", () => true, "anything")).toEqual([])
  })
})

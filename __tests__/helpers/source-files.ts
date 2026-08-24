import { readdirSync, statSync, readFileSync } from "node:fs"
import { join, sep, relative } from "node:path"

// Find source files by content, WITHOUT shelling out to grep.
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
// A family of guards discovered its own population with
// `execSync("grep -rl '…' app --include=route.ts || true")`. That is correct on
// the CI runner and BROKEN ON THE PRIMARY DEV MACHINE, which is Windows — and it
// broke in three different ways, only one of them loud:
//
//   LOUD    metadata-catch-branch-is-not-a-404: the pattern contains spaces, so
//           cmd.exe re-split it and tried to EXECUTE `export`. execSync threw at
//           module scope, so the suite reported "0 test" and the whole guard was
//           DEAD — while CI was green.
//   QUIET   the same shape with a simpler pattern happens to work, so the
//           mechanism looks fine right up until someone widens the pattern.
//   SILENT  ⚠ THE WORST ONE. `|| true` swallows the cmd.exe failure, so a broken
//           shell-out yields an EMPTY file list and the guard walks ZERO files
//           and PASSES. A guard that inspects nothing is indistinguishable at a
//           glance from a guard that found nothing wrong.
//
// The same class hit the path COMPARISONS: `node:path.join` yields backslashes
// on Windows, so `f.replace(process.cwd() + "/", "")` never matched and a guard's
// curated SUPPRESSION list — keyed on forward-slash repo-relative paths — could
// not match either. entity-sections-do-not-conclude-from-a-failed-read reported
// its own deliberately-suppressed entry as an offender.
//
// ⚠ The net effect is the thing worth writing down: `npm test` on the box where
// the development actually happens reported 54 failures across 10 files, none of
// them real. CLAUDE.md requires a full-suite run before every push. An
// instrument that is permanently red for environmental reasons is one a reader
// learns to skim — and a genuinely broken test hides in that noise. It nearly
// did: one real failure was sitting inside that set on 2026-08-24.
//
// ── THE CONTRACT ────────────────────────────────────────────────────────────
// Returns REPO-RELATIVE, FORWARD-SLASH, SORTED paths — byte-identical to what
// `grep -rl` returned on Linux, so a migrating guard's allowlists, ratchets and
// suppression lists keep working untouched on both platforms.

/** Repo-relative, forward slashes — the one path spelling every guard compares against. */
export function repoRelative(absPath: string): string {
  return relative(process.cwd(), absPath).split(sep).join("/")
}

/** Every file under `root` (recursively) whose name satisfies `matchName`. */
export function walkSourceFiles(root: string, matchName: (name: string) => boolean): string[] {
  const out: string[] = []
  const visit = (dir: string) => {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      // A missing root is a real finding, but it is the CALLER's to assert on —
      // every guard here carries a not-vacuous population check. Swallowing it
      // silently is exactly the failure this module exists to end, so the
      // caller's floor assertion is what must catch it.
      return
    }
    for (const e of entries) {
      const p = join(dir, e)
      let st
      try {
        st = statSync(p)
      } catch {
        continue
      }
      if (st.isDirectory()) visit(p)
      else if (matchName(e)) out.push(p)
    }
  }
  visit(join(process.cwd(), root))
  return out
}

/**
 * Files under `root` whose CONTENT matches `pattern` — the portable replacement
 * for `grep -rl`.
 *
 * @param roots      repo-relative directory or directories, e.g. "app/api" or
 *                   ["workers", "supabase/functions"] — the shelled-out form
 *                   passed several roots as bare space-separated arguments.
 * @param matchName  which filenames to consider, e.g. `n => n === "route.ts"`.
 * @param pattern    a plain substring, or a RegExp for the `\|` alternations the
 *                   shelled-out version spelled in BRE.
 *
 * ⚠ Returns [] for a root that does not exist, exactly as `grep … || true` did.
 * Every caller must assert a population floor — see this module's header for
 * what a silently-empty population costs.
 */
export function filesMatching(
  roots: string | string[],
  matchName: (name: string) => boolean,
  pattern: string | RegExp,
): string[] {
  const test =
    typeof pattern === "string"
      ? (src: string) => src.includes(pattern)
      : (src: string) => {
          // A `g` regexp carries lastIndex between calls, which would make the
          // result depend on file ORDER. Test against a fresh, non-global copy.
          const re = new RegExp(pattern.source, pattern.flags.replace(/g/g, ""))
          return re.test(src)
        }
  const all = (Array.isArray(roots) ? roots : [roots]).flatMap((r) =>
    walkSourceFiles(r, matchName),
  )
  return [
    ...new Set(
      all
        .filter((f) => {
          try {
            return test(readFileSync(f, "utf8"))
          } catch {
            return false
          }
        })
        .map(repoRelative),
    ),
  ].sort()
}

// RATCHET — a guard must not grow its own comment stripper.
//
// WHY THIS EXISTS. 37 files had grown a local `stripComments`, and on 2026-08-22
// two separate implementations were measured BLIND, each hiding real source from
// every check built on it:
//
//   1. The 20-copy regex stripper ran the BLOCK regex before the LINE regex, so
//      an ordinary line comment mentioning a glob path (`// used by /api/*`)
//      opened a block comment that closed at the next `*/` ANYWHERE in the file.
//      Measured: 103,590 characters blanked across 49 product files. It hid a
//      live P0 — ~19.6k chars of CollectionAnalyticsClient.tsx, including the
//      branch publishing a 99-day-old row as market depth.
//
//   2. ⚠ THE SWALLOW COMES FROM THE BLOCK REGEX ALONE, which is why the original
//      count of "20 guards" was too low. The line strip is not part of the
//      defect. A further 30 files ran the block regex with NO line strip at all
//      and were blind by the same mechanism — 48,825 characters across 13
//      product files, the same top offenders.
//
// ⚠ THE FAILURE MODE IS WHAT MAKES THIS WORTH A RATCHET: a blind stripper does
// not error. The guard still runs, still reports a population, and still passes
// — it is simply reading a blanked file. Nothing distinguishes it from real
// coverage except a before/after count.
//
// So: every new guard uses `scripts/lib/strip-comments.mjs`. That one has a
// regex-literal state as well, because the state machine originally proposed as
// the fix was ALSO blind — a regex ending in an escaped slash presents raw `//`
// and blanked the rest of the line, in 66 files including the guards' own
// stripper bodies.
//
// ⚠ THIS NUMBER MAY ONLY EVER GO DOWN. Lower it in the same commit that migrates
// a file. NEVER raise it to make a build pass — raising it re-opens exactly the
// blindness this file exists to close.
//
// ⚠ MIGRATING IS NOT MECHANICAL, and one hazard already bit: if the local helper
// is itself named `stripComments`, replacing only its BODY makes it call itself
// and blow the stack. Remove the wrapper, do not delegate to it.
//
// The remainder are narrow readers, walkers over `supabase/migrations` (outside
// the affected set), or tools with their own normalisation needs
// (`extract-cadence`, `check-edge-fn-drift`). Each still deserves migrating; the
// ratchet is what keeps them visible rather than forgotten.

import { describe, it, expect } from "vitest"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join, relative, sep } from "node:path"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

// ⚠ RATCHET BASELINE — down only. 25 (2026-08-22) → 2 (2026-08-22, later same day)
//    → 0 (2026-09-05, the three SQL guards migrated to scripts/lib/strip-sql-comments.mjs).
//
// ⚠ THE NEEDLE CHANGED WITH THIS NUMBER, so the two are not comparable and the
// old 25 must not be read as "23 files were migrated". Both were measured:
//
//   needle = the bare non-greedy body `[\s\S]*?`        → 25, then 7 after migration
//   needle = the block-comment-STRIP shape (below)      → 2
//
// 16 files were genuinely migrated to the shared stripper. The remaining drop
// from 7 to 2 is the needle narrowing, and it removed only FALSE POSITIVES:
// five files that use `[\s\S]*?` for something that is not a comment stripper at
// all — stripping import statements (og-brand-fonts-and-cache,
// server-page-data-access-ratchet), parsing a Set literal
// (public-wallet-surface-contract), parsing the PINS list (check-db-pin-staleness),
// extracting a Cadence template literal (extract-cadence). Each was inspected
// individually; none normalises comments.
//
// ⚠ WHY NARROWING WAS THE RIGHT MOVE AND NOT A LOOSENING: the broad needle could
// never reach zero, because legitimate non-greedy regexes exist and always will.
// A ratchet with a permanent floor made of non-offenders punishes its own success
// and trains readers to ignore its report. The narrow needle is satisfiable at a
// population of zero.
//
// ✅ THE FLOOR IS GONE — 2 → 0 on 2026-09-05, by building the module this note asked
// for rather than by loosening anything. The remaining offenders were SQL strippers,
// not JS ones, and the note above said they "come off this list when a SQL stripper
// exists to move them to, not before". `scripts/lib/strip-sql-comments.mjs` is that
// module: a state machine with a `--` state, NESTED block comments (Postgres nests
// them; a non-greedy regex closes at the first inner terminator), string literals
// with the doubled-quote escape (a `--` inside one is not a comment), and — the
// load-bearing one — dollar-quoted bodies that are KEPT and re-scanned, because this
// repo's real DDL lives inside `DO $mig$ … $mig$` and an opaque-string reading would
// blind every migration guard to it.
//
// ⚠ A third SQL stripper had just been added (the RLS guard), so the population was
// briefly 3 and this ratchet is what caught it — in CI, on the commit that added it.
// That is the ratchet working, and it is why the fix was the shared module rather
// than an exemption.
//
// ⚠ A ratchet with a PERMANENT floor punishes its own success and trains readers to
// ignore its report. That is the argument this file already makes about needle
// narrowing, and it applied to its own floor too.
//
// Measure the population by setting this to 0 and reading the report; never carry
// a number over from a different instrument — including an earlier version of
// THIS one.
const MAX_LOCAL_STRIPPERS = 0

const SHARED = "scripts/lib/strip-comments"

/**
 * The block-comment-STRIP shape — a regex whose body is `/*` … non-greedy … `*\/`.
 *
 * ⚠ This is a SPELLING check, and that boundary is worth stating: a local stripper
 * written with `[^]*?`, or without the `?`, is matched by the alternatives below,
 * but one written some third way would not be. The needle cannot be derived from
 * behaviour — the defect is a property of source text, not of a running function.
 */
const BLOCK_STRIP_RE = new RegExp(
  "\\\\/\\\\\\*\\[(?:\\\\s\\\\S|\\^)\\]\\*\\??\\\\\\*\\\\/"
)

const SELF = "guards-use-the-shared-comment-stripper"
const HELPER = "strip-comments.mjs"

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules") continue
      walk(full, out)
    } else if (/\.(ts|tsx|mjs|js)$/.test(entry)) {
      out.push(full)
    }
  }
  return out
}

/** True when this source rolls its own comment stripper instead of importing the shared one. */
export function rollsItsOwnStripper(src: string): boolean {
  if (src.includes(SHARED)) return false
  // Strip comments first — several files QUOTE the defective pattern in prose to
  // explain the fix, and a guard that fires on its own documentation trains
  // people to delete the documentation.
  return BLOCK_STRIP_RE.test(stripComments(src))
}

describe("guards use the shared comment stripper", () => {
  const files = walk(join(process.cwd(), "__tests__"))
    .concat(walk(join(process.cwd(), "scripts")))
    .filter((f) => !f.includes(HELPER) && !f.includes(SELF))

  it("inspected a non-trivial number of files", () => {
    // A walk that silently finds nothing exits clean and reads as coverage.
    expect(files.length).toBeGreaterThan(200)
  })

  it("POSITIVE CONTROL — detects a rolled-own stripper", () => {
    const rolled = [
      "function stripComments(s) {",
      "  return s.replace(/\\/\\*[" + "\\s\\S" + "]*?\\*\\//g, '')",
      "}",
    ].join("\n")
    expect(rollsItsOwnStripper(rolled)).toBe(true)
  })

  it("NEGATIVE CONTROL — a file importing the shared stripper is not counted", () => {
    const ok = 'import { stripComments } from "../scripts/lib/strip-comments.mjs"\nconst x = stripComments(src)'
    expect(rollsItsOwnStripper(ok)).toBe(false)
  })

  it("NEGATIVE CONTROL — the pattern quoted only inside a comment is not counted", () => {
    // Without this, the ratchet fires on the prose explaining the fix.
    const documented = [
      "// The old shape was .replace(/\\/\\*[" + "\\s\\S" + "]*?\\*\\//g, blanks)",
      "const x = 1",
    ].join("\n")
    expect(rollsItsOwnStripper(documented)).toBe(false)
  })

  it("NEGATIVE CONTROL — an incidental non-greedy regex is not a comment stripper", () => {
    // ⚠ This control exists because the needle was NARROWED on 2026-08-22, and a
    // narrowing is the change most likely to be a silent loosening. Five files
    // left the report that day; every one of them looks like this — a non-greedy
    // body used to parse something, with no comment normalisation anywhere near
    // it. If a future edit widens the needle back, this control reds first and
    // says why.
    const parsesImports = [
      'const body = src.replace(/^import[' + "\\s\\S" + ']*?from\\s+["' + "'" + ']/gm, "")',
    ].join("\n")
    expect(rollsItsOwnStripper(parsesImports)).toBe(false)
  })

  it("POSITIVE CONTROL — the `[^]*?` spelling is caught too", () => {
    // The needle is a spelling check (see BLOCK_STRIP_RE), so each spelling it
    // claims to cover needs its own control or the claim is untested.
    const rolled = 'src.replace(/' + "\\/\\*[^]*?\\*\\/" + '/g, " ")'
    expect(rollsItsOwnStripper(rolled)).toBe(true)
  })

  it("RATCHET: the local-stripper population does not grow", () => {
    const offenders = files
      .filter((f) => rollsItsOwnStripper(readFileSync(f, "utf8")))
      .map((f) => relative(process.cwd(), f).split(sep).join("/"))
      .sort()

    expect(
      offenders.length,
      `Local comment strippers grew to ${offenders.length} (ceiling ${MAX_LOCAL_STRIPPERS}).\n` +
        "A local stripper is not a style preference — two separate implementations were measured\n" +
        "BLIND, hiding real source from every check built on them, and a blind stripper\n" +
        "still passes and still reports a population.\n" +
        'Import { stripComments } from "../scripts/lib/strip-comments.mjs" instead.\n' +
        "If you MIGRATED one, lower MAX_LOCAL_STRIPPERS in the same commit.\n" +
        offenders.map((f) => `  ${f}`).join("\n"),
    ).toBeLessThanOrEqual(MAX_LOCAL_STRIPPERS)
  })
})

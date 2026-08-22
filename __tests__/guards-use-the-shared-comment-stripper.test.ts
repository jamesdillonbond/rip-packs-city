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

// ⚠ RATCHET BASELINE, MEASURED 2026-08-22 — down only.
//
// ⚠ 25, NOT 26. A raw text scan counts 26; this guard strips comments first, and
// retired-orderbook-source-not-rendered-ratchet only QUOTES the defective pattern
// in prose (its real stripper is the state machine). The first draft of this file
// was set to 26 and a mutation test at 25 FAILED TO KILL IT — a ratchet with one
// unit of slack, which is the very thing this file criticises elsewhere. Measure
// the population by setting this to 0 and reading the report; never carry a
// number over from a different instrument.
const MAX_LOCAL_STRIPPERS = 25

const SHARED = "scripts/lib/strip-comments"
/** The block-comment regex body every local stripper is built from. */
const BLOCK_REGEX_BODY = "[" + "\\s\\S" + "]*?"

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
  return stripComments(src).includes(BLOCK_REGEX_BODY)
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

// The monolith inventory is DERIVED FROM THE TREE, not from a list someone
// remembered to update.
//
// WHY THIS EXISTS — the register asked for it, in its own words. known-issues
// #14 ("Monolith page refactor") carries this, added 2026-08-24:
//
//   "AND THE ENTRY'S POPULATION IS A CURATED LIST, SO IT IS SILENT ABOUT THE
//    BIGGEST ONE. app/(collections)/[collection]/pack/dist/[distId]/page.tsx is
//    2,384 lines — larger than any of the three above … and appears in no
//    monolith entry.
//    ➡ Derive this population from the tree by size, not from a list — that is
//    why the largest instance went unnamed."
//
// 🚨 IT HAPPENED AGAIN, AND THAT IS WHY THIS IS A GUARD AND NOT A DOC EDIT.
// Measured 2026-09-07, a fortnight after that note, THREE files over the
// threshold were still named nowhere in the register:
//   · app/api/fmv-recalc/route.ts        2,334
//   · app/api/sniper-feed/route.ts       2,029
//   · app/moment/[id]/page.tsx           1,953  ← a SERVER page, larger than
//     two of the three the register does track, and — exactly like the
//     pack-dist page — measured by NEITHER coverage gate (the primary gate
//     takes lib/** + app/**/route.ts(x), the components gate components/** +
//     app/**/*Client.tsx, so app/**/page.tsx is in neither).
// A prose note telling the next reader to derive the population is itself a
// curated list with one entry. This walks the tree instead.
//
// WHAT IT PINS: every source file at or over the threshold must be NAMED in
// docs/reference/known-issues.md. ⭐ THE REGISTER IS THE SUPPRESSION LIST —
// naming a file is the whole requirement, not fixing or scheduling it. "2,300
// lines, acknowledged, not scheduled" is a perfectly good register entry and
// passes. What must never happen again is a file this size being invisible.
//
// ⛔ IT DOES NOT PIN LINE COUNTS. Every figure in that register is a DATED
// SAMPLE (CLAUDE.md), and a test asserting "SniperClient is 1,849 lines" would
// red on every edit and teach people to bump numbers without reading them.
// Membership is stable; size is not. The counts are PRINTED on failure so the
// register's dated numbers can be re-derived by hand, which is the only way
// they stay honest.

import { describe, it, expect } from "vitest"
import { readFileSync, readdirSync, statSync } from "node:fs"
import path from "node:path"

const ROOT = process.cwd()
const ROOTS = ["app", "components", "lib"]

/**
 * A file a reviewer cannot hold in their head. The exact number is a judgement
 * call, not a measurement — it is set where it splits a real gap in this tree
 * (1,574 above, 1,416 below as of 2026-09-07) rather than through a cluster,
 * so ordinary edits do not push files back and forth across it.
 *
 * ⚠ Lowering it is fine and makes the guard stricter; every newly-caught file
 * just needs naming. RAISING it to make a failure go away is the one edit that
 * defeats the point — name the file instead.
 */
const THRESHOLD_LINES = 1500

/**
 * Basenames that identify nothing on their own. Next's routing convention means
 * dozens of files share them, so for these the register must carry the PATH.
 * Any other basename is distinctive enough to match on (the register's existing
 * #14 table names `SniperClient.tsx` and `CollectionAnalyticsClient.tsx` that
 * way, and rejecting that style would fail two files the register does track).
 */
const GENERIC_BASENAMES = new Set([
  "page.tsx", "route.ts", "route.tsx", "layout.tsx", "loading.tsx",
  "error.tsx", "not-found.tsx", "index.ts", "index.tsx", "types.ts",
])

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (/\.tsx?$/.test(entry.name)) out.push(full)
  }
  return out
}

/**
 * ⚠ NEWLINE COUNT, i.e. `wc -l` semantics — deliberately, not `split("\n").length`.
 * The latter counts a trailing newline as an extra line, so the two instruments
 * disagree by one on every normal file. The register's numbers are quoted from
 * `wc -l`; two instruments that differ by one invite someone to "correct" the
 * register to match a test, or the reverse, forever.
 */
function lineCount(abs: string): number {
  const src = readFileSync(abs, "utf8")
  let n = 0
  for (let i = 0; i < src.length; i += 1) if (src.charCodeAt(i) === 10) n += 1
  return n
}

describe("monolith inventory", () => {
  const register = readFileSync(path.join(ROOT, "docs/reference/known-issues.md"), "utf8")

  const all = ROOTS.flatMap((r) => walk(path.join(ROOT, r)))
  const large = all
    .map((abs) => ({ rel: path.relative(ROOT, abs).split(path.sep).join("/"), lines: lineCount(abs) }))
    .filter((f) => f.lines >= THRESHOLD_LINES)
    .sort((a, b) => b.lines - a.lines)

  it("the walk actually inspected the tree (population control)", () => {
    // Without this, a broken walk returns [] and every assertion below passes
    // by inspecting nothing — the exact way three earlier guards on this repo
    // died. Assert the DENOMINATOR, not just the finding.
    expect(all.length, "the tree walk found almost no source files").toBeGreaterThan(500)
    expect(register.length).toBeGreaterThan(10_000)
    // …and that the threshold selects a real, non-empty population. If this
    // ever hits zero the codebase got dramatically smaller or the walk broke;
    // either way it should be looked at, not passed silently.
    expect(large.length, "no file is over the threshold — verify before relaxing this").toBeGreaterThan(3)
  })

  it("every file over the threshold is named in the register", () => {
    const unnamed = large.filter(({ rel }) => {
      if (register.includes(rel)) return false
      const base = path.basename(rel)
      if (!GENERIC_BASENAMES.has(base) && register.includes(base)) return false
      return true
    })

    const report = unnamed.map((f) => `  ${String(f.lines).padStart(6)}  ${f.rel}`).join("\n")
    const inventory = large.map((f) => `  ${String(f.lines).padStart(6)}  ${f.rel}`).join("\n")

    expect(
      unnamed,
      `These files are at or over ${THRESHOLD_LINES} lines and appear NOWHERE in\n` +
        `docs/reference/known-issues.md:\n\n${report}\n\n` +
        `Name each one in the register — that is the whole fix. You do NOT have to\n` +
        `schedule or refactor it; "acknowledged, not scheduled" is a fine entry.\n` +
        `⛔ Do NOT raise THRESHOLD_LINES to make this pass.\n\n` +
        `Current inventory (re-derive the register's dated numbers from this):\n${inventory}\n`,
    ).toEqual([])
  })
})

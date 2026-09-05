// __tests__/pack-dist-bounded-reads-are-logged-exactly-once.test.ts
//
// Every `bounded(...)` read in `lib/pack-dist/fetchers.ts` must log its failure
// EXACTLY ONCE: not twice (which doubles the measured incidence) and not zero
// times (which hides it).
//
// ── WHY: ONE FAILURE WAS ARRIVING AS TWO ───────────────────────────────────
// The local `bounded()` helper used to `console.error("<label> bound", …)` in
// its catch, and every call site ALSO logs `console.error("<label> error", …)`
// in the `if (error)` branch the helper is designed to feed. So a single
// timeout produced two lines, and Vercel grouped them as two separate error
// clusters. Measured over 12 h to 2026-09-05:
//
//     [pack-detail] pack_lifecycle bound      count=6
//     [pack-detail] pack_lifecycle error      count=6
//     [pack-detail] pack_realized_ev bound    count=4
//     [pack-detail] pack_realized_ev error    count=4
//
// ⭐ The identical counts are the tell — they are the same six and four events.
// `/[collection]/pack/dist/[distId]` looked like it had six distinct problems
// when it had three, and anyone counting occurrences read TWICE the real rate.
// CLAUDE.md's rule for this class is to fix the record and not just the code:
// "fix the guard AND the field an observer keys on."
//
// ── WHY THE CALLER'S LOG IS THE ONE KEPT ───────────────────────────────────
// ⚠ COVERAGE, not preference. The helper's catch fires only on the REJECT path
// (a `withBoardBudget` timeout). A real PostgREST error resolves normally and
// never reaches it — it arrives at the call site's `if (error)` branch. Keeping
// the helper's log and dropping the callers' would have silently stopped logging
// every non-timeout failure.
//
// ── WHAT THIS GUARD IS FOR ─────────────────────────────────────────────────
// Removing the helper's log is safe ONLY because all 13 call sites log on their
// error branch. That is a property of thirteen separate code paths, so it is
// exactly the kind of thing that decays: a 14th `bounded(...)` added without an
// `if (error)` branch would fail SILENTLY, which is strictly worse than the
// double-logging this replaced.

import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const FILE = join(process.cwd(), "lib", "pack-dist", "fetchers.ts")

/** Lines that start a `bounded(...)` read, 1-indexed. */
export function boundedCallLines(src: string): number[] {
  const out: number[] = []
  src.split("\n").forEach((l, i) => {
    if (/=\s*await bounded\(/.test(l)) out.push(i + 1)
  })
  return out
}

/**
 * Does the window after a call site contain an error branch that LOGS?
 *
 * ⚠ The error identifier is not always `error` — one site destructures
 * `{ data: poolRows, error: poolErr }`. Matching only `if (error)` would pass
 * that site vacuously, so this accepts any identifier ending in `rr` or `rror`.
 */
function branchLogs(src: string, line: number, span = 16): boolean {
  const win = src.split("\n").slice(line - 1, line - 1 + span).join("\n")
  const hasBranch = /if\s*\(\s*[A-Za-z_$][\w$]*(rr|rror)\s*\)/.test(win)
  const logs = /console\.(error|warn)\(/.test(win)
  return hasBranch && logs
}

describe("pack-dist bounded reads log their failure exactly once", () => {
  const src = readFileSync(FILE, "utf8")

  it("inspected a non-trivial number of bounded reads", () => {
    // A walk that finds nothing exits clean and reads as coverage.
    expect(boundedCallLines(src).length).toBeGreaterThanOrEqual(10)
  })

  it("EVERY bounded() call site logs on its error branch", () => {
    const silent = boundedCallLines(src).filter((l) => !branchLogs(src, l))
    expect(
      silent,
      "These `bounded(...)` reads have no logging error branch. The helper is\n" +
        "deliberately silent (it would double-log), so a site without its own\n" +
        "`if (error) console.error(...)` fails INVISIBLY — worse than the\n" +
        "double-logging that silence replaced. Add the branch, or restore a log.\n" +
        "Offending lines: ",
    ).toEqual([])
  })

  it("BAN AT ZERO — the bounded() helper does not log (that is what doubled it)", () => {
    // Scope to the helper body so a caller's legitimate log cannot satisfy or
    // trip this: the helper ends at the first `}` closing its catch.
    const start = src.indexOf("async function bounded(")
    expect(start, "the bounded() helper was renamed or moved").toBeGreaterThan(-1)
    const body = src.slice(start, src.indexOf("\n}\n", start))
    // Comments explain the removed log by name, so strip them before matching —
    // a guard satisfied (or tripped) by its own documentation is a recorded
    // failure mode in this repo.
    const code = body
      .split("\n")
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join("\n")
    expect(
      /console\.(error|warn)\(/.test(code),
      "bounded() logs again. One failure then arrives as TWO Vercel error groups\n" +
        "with identical counts, doubling the measured incidence for pack-detail.",
    ).toBe(false)
  })

  it("POSITIVE CONTROL — a call site with no error branch is detected", () => {
    const rolled = ["const { data, error } = await bounded(x, 'y')", "return data"].join("\n")
    expect(boundedCallLines(rolled)).toEqual([1])
    expect(branchLogs(rolled, 1)).toBe(false)
  })

  it("NEGATIVE CONTROL — a renamed error identifier still counts as logged", () => {
    // The `poolErr` site would otherwise read as silent and this guard would
    // fire on correct code.
    const renamed = [
      "const { data: poolRows, error: poolErr } = await bounded(x, 'y')",
      "if (poolErr) {",
      '  console.error("[pack-detail] pool error", poolErr.message)',
      "}",
    ].join("\n")
    expect(branchLogs(renamed, 1)).toBe(true)
  })
})

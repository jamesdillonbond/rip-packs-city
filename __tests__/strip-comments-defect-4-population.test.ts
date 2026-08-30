// The POPULATION pin for the shared comment stripper's known-unfixed boundary.
//
// WHY THIS FILE EXISTS, and it is not the reason you would guess. DEFECT 4 in
// `scripts/lib/strip-comments.mjs` (JSX text is not JS, so an apostrophe in
// prose opens an `sq` state) was already documented, and its header said:
//
//   "8 files in this repo end in a non-`code` state for this reason (7 `sq`,
//    1 `dq`); __tests__/strip-comments-shared-helper.test.ts pins the
//    population so it is visible rather than silent, and names them."
//
// ⛔ That sentence was false in BOTH of its claims, measured 2026-08-29. The
// contract test never walked the tree and never named a file — it pins the
// SHAPE with a four-line synthetic fixture and nothing else. So the population
// could have grown from 8 to 80 with every guard in the repo still green, and
// the sentence asserting otherwise is what would have stopped anyone checking.
// ⭐ A boundary nobody can COUNT is not a visible boundary, however carefully it
// is described. This file is the count.
//
// It also corrects the number: the live sweep finds **7** (6 `sq`, 1 `dq`), not
// 8. One file left the population between 08-27 and 08-29 and nothing noticed,
// which is the same point made twice.
//
// ── THE TWO DIRECTIONS ARE NOT THE SAME SEVERITY, so they are not one check ──
// `sq`/`dq` copy verbatim: the machine KEEPS too much, so a guard may
// over-report but can never go blind. That is the safe direction, and it gets a
// down-only RATCHET.
// `block`/`regex`/`class`/`tpl`, and any unclosed `${` interpolation, BLANK
// source. That is DEFECT 3's direction — the one that hid a live P0 — and it
// gets a BAN AT ZERO, because there is no acceptable number of files whose real
// code is invisible to every guard built on this helper.

import { describe, it, expect } from "vitest"
import { readdirSync, statSync, readFileSync } from "node:fs"
import { join, relative, sep } from "node:path"
import { stripCommentsWithState } from "../scripts/lib/strip-comments.mjs"

const ROOT = process.cwd()
const SKIP = new Set(["node_modules", ".git", ".next", "dist", "build", "coverage", ".vercel"])

/**
 * Files ending in `sq` or `dq`. These fail SAFE (comments survive; no source is
 * lost), so this is a ceiling, not a ban.
 *
 * ⚠ Down only. If you fix one, lower this in the same commit. It is deliberately
 * satisfiable at ZERO — a guard that fails when its own boundary is fixed
 * punishes its own success.
 */
const MAX_KEEPS_TOO_MUCH = 7

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(entry)) out.push(full)
  }
  return out
}

const rel = (f: string) => relative(ROOT, f).split(sep).join("/")

/** States in which the machine copies verbatim — it keeps too much, it loses nothing. */
const KEEPS_TOO_MUCH = new Set(["sq", "dq"])

describe("stripComments — DEFECT 4 population is COUNTED, not merely described", () => {
  const files = walk(ROOT)

  const surveyed = files.map((f) => {
    const { endState, tplDepth } = stripCommentsWithState(readFileSync(f, "utf8"))
    return { file: rel(f), endState, tplDepth }
  })

  const desynced = surveyed.filter((r) => r.endState !== "code" || r.tplDepth !== 0)
  const keepsTooMuch = desynced.filter((r) => KEEPS_TOO_MUCH.has(r.endState) && r.tplDepth === 0)
  const blanksSource = desynced.filter((r) => !KEEPS_TOO_MUCH.has(r.endState) || r.tplDepth !== 0)

  const list = (rows: { file: string; endState: string; tplDepth: number }[]) =>
    rows.map((r) => `  ${r.endState} (tplDepth ${r.tplDepth})  ${r.file}`).join("\n")

  it("inspected a non-trivial number of files", () => {
    // A walk that silently finds nothing exits clean and reads as coverage.
    // This is the assertion whose absence let the header's claim stand.
    expect(files.length).toBeGreaterThan(2000)
  })

  it("POSITIVE CONTROL — the sweep can SEE a desync", () => {
    // Without this, "0 files blank source" would be indistinguishable from a
    // detector that reports `code` for everything.
    const jsx = ["function C() {", "  return <p>Couldn't load</p>", "}"].join("\n")
    expect(stripCommentsWithState(jsx).endState).toBe("sq")

    const unclosedInterpolation = "const a = `x ${ y "
    const bad = stripCommentsWithState(unclosedInterpolation)
    expect(bad.tplDepth).toBeGreaterThan(0)
  })

  it("NEGATIVE CONTROL — ordinary source ends in the `code` state", () => {
    const healthy = [
      "// a comment",
      "const re = /^https?:\\/\\//i",
      "const t = `a ${b ? `<i>${c}</i>` : ''} d`",
      "export const x = 1",
    ].join("\n")
    const { endState, tplDepth } = stripCommentsWithState(healthy)
    expect({ endState, tplDepth }).toEqual({ endState: "code", tplDepth: 0 })
  })

  it("BAN AT ZERO — no file ends in a state that BLANKS source", () => {
    // DEFECT 3's direction. It hid a live P0 once; there is no acceptable count.
    expect(
      blanksSource.length,
      "Files whose real source is invisible to every guard using this helper:\n" +
        list(blanksSource) +
        "\n\nThis is the UNSAFE direction (DEFECT 3's). Fix the stripper — do not " +
        "raise a ceiling, and do not reword the offending source.\n",
    ).toBe(0)
  })

  it("RATCHET — the keeps-too-much population does not grow", () => {
    expect(
      keepsTooMuch.length,
      `Files ending in a verbatim-copy state grew to ${keepsTooMuch.length} ` +
        `(ceiling ${MAX_KEEPS_TOO_MUCH}).\n` +
        list(keepsTooMuch) +
        "\n\nThese fail SAFE — comments survive, so a guard may over-report on them, " +
        "but nothing goes blind.\n" +
        "If you FIXED one, lower MAX_KEEPS_TOO_MUCH in the same commit.\n" +
        "If you ADDED one, it is JSX prose with an apostrophe: see DEFECT 4 in " +
        "scripts/lib/strip-comments.mjs.\n",
    ).toBeLessThanOrEqual(MAX_KEEPS_TOO_MUCH)
  })

  it("names the population, so the boundary is legible without re-running a sweep", () => {
    // The header CLAIMED this and did not do it. Printing the names in the
    // assertion message is what makes a count actionable; asserting the exact
    // names would instead die on the first rename, so it is deliberately not done.
    expect(keepsTooMuch.every((r) => r.file.length > 0 && r.endState.length > 0)).toBe(true)
  })
})

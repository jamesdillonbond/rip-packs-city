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
import { readdirSync, statSync, readFileSync, mkdirSync, writeFileSync, mkdtempSync } from "node:fs"
import { join, relative, sep } from "node:path"
import { tmpdir } from "node:os"
import { stripCommentsWithState } from "../scripts/lib/strip-comments.mjs"

const ROOT = process.cwd()

/** Unambiguous build/VCS noise at ANY depth. */
const SKIP_ANYWHERE = new Set(["node_modules", ".git"])

/**
 * Build output — skipped ONLY at the repo root.
 *
 * ⛔ THIS SPLIT IS A BUG FIX, NOT TIDINESS. The first version of this guard
 * skipped all of these by bare name at any depth, which silently excluded
 * `app/(collections)/[collection]/pack/dist/[distId]/page.tsx` — **`dist` is a
 * real ROUTE SEGMENT here, not build output** — hiding the repo's third-largest
 * source file (2,384 lines) and its sibling `error.tsx` from a guard whose
 * entire purpose is to make a blind spot countable. The census read 2,871 files
 * and should have read 2,881.
 * ⭐ The population was unchanged (both files end `code`), so nothing was
 * mis-reported — but it was luck, not design, and a name-based exclusion is a
 * CLAIM about every directory in the tree that happens to share the name.
 */
const SKIP_AT_ROOT = new Set([".next", "dist", "build", "coverage", ".vercel"])

/**
 * Files ending in `sq` or `dq`. These fail SAFE (comments survive; no source is
 * lost), so this is a ceiling, not a ban.
 *
 * ⚠ Down only. If you fix one, lower this in the same commit. It is deliberately
 * satisfiable at ZERO — a guard that fails when its own boundary is fixed
 * punishes its own success.
 */
const MAX_KEEPS_TOO_MUCH = 7

export function walk(dir: string, depth = 0, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_ANYWHERE.has(entry)) continue
    if (depth === 0 && SKIP_AT_ROOT.has(entry)) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, depth + 1, out)
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

  it("the walk skips build output at the ROOT but not a `dist` ROUTE SEGMENT", () => {
    // Built on a SYNTHETIC tree rather than by naming the real route, because a
    // guard that names its instances dies on the first rename — and this repo
    // has lost three that way. The property is about the walk, not about which
    // route currently happens to contain a `dist` segment.
    const tmp = mkdtempSync(join(tmpdir(), "walk-scope-"))
    mkdirSync(join(tmp, "dist"), { recursive: true })
    mkdirSync(join(tmp, "app", "pack", "dist", "x"), { recursive: true })
    mkdirSync(join(tmp, "node_modules", "pkg", "dist"), { recursive: true })
    writeFileSync(join(tmp, "dist", "bundle.js"), "// root build output")
    writeFileSync(join(tmp, "app", "pack", "dist", "x", "page.tsx"), "export const a = 1")
    writeFileSync(join(tmp, "node_modules", "pkg", "dist", "i.d.ts"), "export {}")

    const found = walk(tmp).map((f) => relative(tmp, f).split(sep).join("/"))

    // The bug: a bare-name skip drops this real source file.
    expect(found).toContain("app/pack/dist/x/page.tsx")
    // Still excluded, or the census would drown in build output.
    expect(found).not.toContain("dist/bundle.js")
    expect(found).not.toContain("node_modules/pkg/dist/i.d.ts")
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

// ─────────────────────────────────────────────────────────────────────────────
// ⚠ THE END-STATE CENSUS ABOVE UNDER-REPORTS, AND IT UNDER-REPORTS THE WORST
// FILE IN THE REPO. Measured 2026-09-12.
//
// `endState` can only see a desync that is STILL OPEN at EOF. JSX prose carries
// apostrophes in PAIRS as often as not — "we'll … doesn't" — so the machine
// opens `sq` on the first, copies everything between the two verbatim (comments
// included), CLOSES on the second, and reports `code` at EOF. Healthy, by that
// probe. `app/dashboard/DashboardClient.tsx` was exactly that file, and the
// largest instance in the repo: **1,076 of its lines** read in a bogus string
// state, 63 comment lines surviving into every guard built on this helper. It
// reddened `no-rewards-promises-while-unshipped` on 2026-09-12 by handing it a
// code comment about the +50 Status award as published copy.
//
// ⚠ It was then partly reworded (`0871fff1c`) to get CI green, and IS STILL IN
// THE POPULATION at 203 lines. A reword moves the boundary and leaves behind the
// impression that it is gone — which is the argument for a named, ratcheted
// census over a one-off fix. Sweep total the same day: 1,764 lines before the
// reword, 898 after, across the same 10 files.
//
// ⭐ THE DETECTOR BELOW NEEDS NO PROXY, because a single- or double-quoted
// string CANNOT SPAN A NEWLINE in JS/TS. So a line whose START state is `sq` or
// `dq` is not evidence of a desync — it IS one, wherever it sits in the file
// and whether or not the machine later re-syncs. `tpl` is excluded for the same
// reason it must be: a template literal spanning newlines is ordinary, and the
// `//` inside our Cadence transactions is source that MUST survive. A first cut
// of this census counted those and over-reported 13 files where there are 10.
//
// ⚠ CHECKED, not assumed: this census STRICTLY CONTAINS the keeps-too-much
// ratchet above (all 7 of those files are among these 10), so that ceiling is
// now a subset view. The BAN AT ZERO above is not subsumed and must stay — it
// covers the `block`/`regex`/`tpl` states, which BLANK source rather than keep
// it, and which no string-state probe can see.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Files with at least one line read in an unterminated-string state.
 *
 * ⚠ Down only, and satisfiable at ZERO — a guard that reds when its own
 * boundary is fixed punishes its own success. Lines are reported but NOT
 * ratcheted: the line count moves with ordinary editing inside an already-
 * desynced file, and a ceiling that churns gets raised rather than read.
 */
const MAX_FILES_WITH_STRING_DESYNC = 10

describe("stripComments — DEFECT 4 is counted where it HAPPENS, not only at EOF", () => {
  const files = walk(ROOT)

  const desync = files
    .map((f) => {
      const { lineStates } = stripCommentsWithState(readFileSync(f, "utf8"))
      return { file: rel(f), lines: lineStates.filter((st) => st === "sq" || st === "dq").length }
    })
    .filter((r) => r.lines > 0)
    .sort((a, b) => b.lines - a.lines)

  it("the DETECTOR discriminates — pinned instead of read off the tree", () => {
    // Without this the census could silently stop detecting and the ratchet
    // would pass having counted nothing — the vacuous-guard trap this whole
    // file exists to close. Positive control, negative control, and the
    // template-literal control that the first cut of this census got wrong.
    const bad = stripCommentsWithState("const s = <p>we'll go</p>\n// KEPT\nconst t = 'x'\n")
    expect(bad.lineStates[1]).toBe("sq")
    const good = stripCommentsWithState("const s = <p>we will go</p>\n// STRIPPED\n")
    expect(good.lineStates[1]).toBe("code")
    // Cadence/SQL prose in a template literal is NOT a desync and its `//` is
    // source, not a comment.
    const tpl = stripCommentsWithState("const q = `\n// cadence comment\n`\n")
    expect(tpl.lineStates[1]).toBe("tpl")
    expect(tpl.code).toContain("// cadence comment")
  })

  it("lineStates lines up 1:1 with the file's lines", () => {
    // If this drifts, every index above names the wrong line and the census
    // becomes confidently wrong rather than merely absent.
    for (const f of files.slice(0, 200)) {
      const src = readFileSync(f, "utf8")
      expect(stripCommentsWithState(src).lineStates.length).toBe(src.split("\n").length)
    }
  })

  it("RATCHET — the number of files with a string desync does not grow", () => {
    expect(
      desync.length,
      `Files with an unterminated-string desync grew to ${desync.length} ` +
        `(ceiling ${MAX_FILES_WITH_STRING_DESYNC}); ` +
        `${desync.reduce((n, r) => n + r.lines, 0)} lines total.\n` +
        desync.map((r) => `  ${String(r.lines).padStart(5)} lines  ${r.file}`).join("\n") +
        "\n\nEvery guard built on stripComments reads those lines verbatim — comments\n" +
        "included — so it may over-report on them. Nothing goes blind.\n" +
        "If you ADDED one, it is an apostrophe in JSX prose: see DEFECT 4 in\n" +
        "scripts/lib/strip-comments.mjs. Rephrasing the prose is a workaround, not\n" +
        "the fix; a guard whose subject is user-facing COPY should instead stop\n" +
        "depending on the stripper being right (see copyOf in\n" +
        "__tests__/no-rewards-promises-while-unshipped.test.ts).\n" +
        "If you FIXED one, lower MAX_FILES_WITH_STRING_DESYNC in the same commit.\n",
    ).toBeLessThanOrEqual(MAX_FILES_WITH_STRING_DESYNC)
  })

  it("names the population, and the count is not zero by accident", () => {
    // ⚠ A census that finds nothing reads identically to a broken one. While
    // the boundary exists this must find it; the day the stripper gains real
    // JSX awareness, this assertion is deleted in the same commit that takes
    // the ceiling to 0.
    expect(desync.length).toBeGreaterThan(0)
    expect(desync.every((r) => r.file.length > 0 && r.lines > 0)).toBe(true)
  })
})

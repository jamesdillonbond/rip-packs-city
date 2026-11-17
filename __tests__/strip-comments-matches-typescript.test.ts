// The shared comment stripper, checked against an INDEPENDENT instrument.
//
// WHY THIS EXISTS, and why it is not another hand-written fixture. Every defect
// this helper has had — four of them, listed in its header, each of which hid
// real source from a guard or handed a guard a comment as evidence — was found
// by accident, weeks or months after it shipped, and each was pinned afterwards
// by a fixture written to describe the case that had just been found. A fixture
// can only assert the defect its author already knows about. **The stripper's
// contract is not a list of cases: it is "blank exactly the comments, and
// nothing else", over a real tree.**
//
// ⭐⭐ TypeScript's own parser is the ground truth for that contract, and it is
// independent in the way that matters: it is the thing that DEFINES what a
// comment is in `.ts` and `.tsx`, it resolves JSX by file extension (which this
// helper cannot — see DEFECT 4 in the header), and it shares no code, no author
// and no assumption with the state machine under test. So the assertion is not
// "does the stripper handle apostrophes in JSX" but "does it agree with the
// compiler about every character of every file in this repo".
//
// ── WHAT EACH DIRECTION MEANS, because they are not the same severity ────────
// A range TypeScript calls a comment that the stripper KEEPS is a comment
// leaking into every guard built on this helper — a guard reads its own
// explanation as evidence. That is DEFECT 4's direction, and it reddened
// `no-rewards-promises-while-unshipped` on 2026-09-12 by presenting a code
// comment about a +50 Status award as published copy.
// A range TypeScript calls SOURCE that the stripper BLANKS is worse: the guard
// goes blind, passes, and reports a population it never inspected. That is
// DEFECT 1/2/3's direction, and it hid a live P0 (the D12b order-book surface,
// ~19.6k characters invisible).
// Both are asserted, separately, with the offending file and line named.

import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { relative, sep } from "node:path"
import ts from "typescript"
import { stripComments } from "../scripts/lib/strip-comments.mjs"
// ⚠ From the shared helper, NOT from the census test file. Importing one
// `*.test.ts` into another re-registers its suites here — the census ran twice
// under this filename before this import moved. See the note in source-files.ts.
import { walkRepoSourceTree as walk } from "./helpers/source-files"

const ROOT = process.cwd()
const rel = (f: string) => relative(ROOT, f).split(sep).join("/")

/**
 * Every comment range TypeScript finds, as a per-character mask.
 *
 * ⚠ It walks LEAF TOKENS and reads BOTH leading and trailing trivia at each
 * token's full start. Both details are bug fixes, not ceremony:
 *   - A node walk misses a comment sitting before a closing brace, because no
 *     node starts there. The first cut of this oracle did that and reported 525
 *     false "source destroyed" files.
 *   - `getLeadingCommentRanges` deliberately EXCLUDES a comment on the same
 *     line as the preceding token — that is *trailing* trivia of that token.
 *     Omitting the trailing sweep reported 905 more. ⭐ Both were the ORACLE
 *     being wrong, not the stripper, and both looked exactly like real findings.
 *   - `JsxText` is skipped: its content is prose, so scanning it for "trivia"
 *     invents comments that are not there.
 */
function typescriptCommentMask(file: string, text: string): Uint8Array {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const mask = new Uint8Array(text.length)
  const mark = (r: ts.CommentRange) => {
    for (let k = r.pos; k < r.end && k < text.length; k++) mask[k] = 1
  }
  const visit = (n: ts.Node) => {
    if (n.kind === ts.SyntaxKind.JsxText) return
    const kids = n.getChildren(sf)
    if (kids.length === 0) {
      const pos = n.getFullStart()
      ;(ts.getLeadingCommentRanges(text, pos) || []).forEach(mark)
      ;(ts.getTrailingCommentRanges(text, pos) || []).forEach(mark)
    } else kids.forEach(visit)
  }
  visit(sf)
  return mask
}

/**
 * What a stripper blanked, as a per-character mask.
 *
 * ⚠ Comparable only on NON-WHITESPACE characters, and that is a property of the
 * blanking rule rather than a shortcut: comments become spaces, so an original
 * space that stays a space is indistinguishable from one that was blanked. A
 * comparison that ignores this reports every file in the repo as a mismatch —
 * the first cut of this oracle read 2,945 false positives that way.
 */
function blankedMask(text: string, strip: (s: string) => string): Uint8Array {
  const code = strip(text)
  const mask = new Uint8Array(text.length)
  for (let k = 0; k < text.length; k++) if (code[k] !== text[k]) mask[k] = 1
  return mask
}

type Mismatch = { file: string; line: number; chars: number; context: string }

function compare(files: string[], strip: (s: string) => string) {
  const keptByUs: Mismatch[] = [] // TS says comment, we keep   → leaks into guards
  const blankedByUs: Mismatch[] = [] // TS says source,  we blank  → guard goes blind
  let agreed = 0
  // ⚠ Counted HERE, during the one pass that already parses every file, rather
  // than by a second sweep in the non-vacuity control below. See the CI-cost
  // note on that test: re-walking the tree cost more than the whole guard.
  let filesWithComments = 0

  for (const f of files) {
    const text = readFileSync(f, "utf8")
    let truth: Uint8Array
    try {
      truth = typescriptCommentMask(f, text)
    } catch {
      continue // a file TypeScript cannot parse is not evidence about the stripper
    }
    const ours = blankedMask(text, strip)
    if (truth.some((b) => b === 1)) filesWithComments++

    let missed = 0
    let over = 0
    let firstMissed = -1
    let firstOver = -1
    for (let k = 0; k < text.length; k++) {
      if (text[k] === " " || text[k] === "\n" || text[k] === "\t" || text[k] === "\r") continue
      if (truth[k] && !ours[k]) {
        missed++
        if (firstMissed < 0) firstMissed = k
      }
      if (!truth[k] && ours[k]) {
        over++
        if (firstOver < 0) firstOver = k
      }
    }
    const lineAt = (p: number) => text.slice(0, p).split("\n").length
    const ctx = (p: number) => text.slice(p, p + 70).split("\n")[0]
    if (missed) keptByUs.push({ file: rel(f), line: lineAt(firstMissed), chars: missed, context: ctx(firstMissed) })
    if (over) blankedByUs.push({ file: rel(f), line: lineAt(firstOver), chars: over, context: ctx(firstOver) })
    if (!missed && !over) agreed++
  }
  return { keptByUs, blankedByUs, agreed, filesWithComments }
}

const show = (rows: Mismatch[]) =>
  rows
    .slice(0, 30)
    .map((r) => `  ${String(r.chars).padStart(6)} ch  ${r.file}:${r.line}  ${JSON.stringify(r.context)}`)
    .join("\n")

describe("stripComments agrees with the TypeScript compiler, character for character", () => {
  const files = walk(ROOT)
  const result = compare(files, stripComments)

  it("inspected the whole tree, not a sample", () => {
    // ⚠ A sweep that silently matches nothing exits clean and reads as coverage.
    // This repo has shipped that exact guard before.
    expect(files.length).toBeGreaterThan(2000)
    expect(result.agreed).toBeGreaterThan(2000)
  })

  it("BAN AT ZERO — no comment survives into a guard as source", () => {
    expect(
      result.keptByUs.length,
      "Files where TypeScript sees a comment and the stripper KEEPS it.\n" +
        "Every guard built on this helper reads those characters as source, so it\n" +
        "can read its own explanation as evidence. This is DEFECT 4's direction.\n" +
        show(result.keptByUs) +
        "\n",
    ).toBe(0)
  })

  it("BAN AT ZERO — no source is blanked", () => {
    expect(
      result.blankedByUs.length,
      "Files where TypeScript sees SOURCE and the stripper BLANKS it.\n" +
        "This is the severe direction: a guard goes blind, passes, and reports a\n" +
        "population it never inspected. It hid a live P0 once (DEFECT 1).\n" +
        show(result.blankedByUs) +
        "\n",
    ).toBe(0)
  })

  // ── The controls. Two zeros above are worth nothing unless this comparison
  // can produce a non-zero, and it must be able to do so in BOTH directions
  // independently — a harness that only ever detects one is half a guard that
  // reads as a whole one.
  //
  // 🚨 COST IS PART OF THE DESIGN HERE, and getting it wrong reddened `main`.
  // Parsing the tree with the TypeScript compiler is the expensive thing this
  // file does, so it happens EXACTLY ONCE, in the sweep above. The controls
  // below either reuse what that pass already counted or run on a small sample.
  // ⚠ The first version re-walked all 3,008 files inside the non-vacuity
  // control. It took 7.4 s on a 16-core idle box and **timed out at 30 s on a
  // 2-core CI runner under coverage instrumentation** — `main` went red on a
  // commit whose full suite had just passed locally. *A probe whose HARNESS
  // differs from production in the one dimension the answer depends on is not
  // a measurement of production*, and "it passed on my box" is exactly that
  // probe. Keep every `it` in this file O(sample), never O(tree).
  const SAMPLE = files.slice(0, 150)

  it("POSITIVE CONTROL — a stripper that keeps comments is CAUGHT", () => {
    const identity = (s: string) => s
    const broken = compare(SAMPLE, identity)
    expect(broken.keptByUs.length).toBeGreaterThan(50)
    expect(broken.blankedByUs.length).toBe(0) // it blanks nothing, so nothing is destroyed
  })

  it("POSITIVE CONTROL — a stripper that blanks SOURCE is CAUGHT", () => {
    // The DEFECT 1 shape, verbatim: block comments stripped before line
    // comments, so a `//` mentioning a glob path opens a block comment that
    // closes at the next `*/` hundreds of lines away.
    const defect1 = (s: string) =>
      s
        .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
        .replace(/(^|[^:])\/\/.*$/gm, (m) => m.replace(/[^\n]/g, " "))
    const broken = compare(SAMPLE, defect1)
    expect(broken.blankedByUs.length).toBeGreaterThan(0)
  })

  it("NEGATIVE CONTROL — the comparison is not simply reporting zero for everything", () => {
    // Distinguishes "the stripper is correct" from "the masks are both empty".
    // Without it, a `typescriptCommentMask` that silently returned all-zeros
    // would make every assertion above pass while testing nothing.
    //
    // ⚠ Read off the sweep's own counter. It used to re-derive this by parsing
    // every file again — the same answer for four minutes of CI and a red
    // `main`. A control must be cheap enough to keep, or it gets deleted.
    expect(result.filesWithComments).toBeGreaterThan(1000)
  })
})

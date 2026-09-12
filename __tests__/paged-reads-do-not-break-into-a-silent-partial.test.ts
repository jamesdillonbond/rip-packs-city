import { describe, it, expect } from "vitest"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative, sep } from "node:path"
import { stripComments } from "../scripts/lib/strip-comments.mjs"
import { isMarkerSuppressed } from "../scripts/lib/marker-suppression.mjs"

// BAN (population ZERO after 2026-09-12) on a paging loop that `break`s out of
// an ERROR branch without recording that the walk was cut short.
//
// ── THE CLASS ───────────────────────────────────────────────────────────────
//
//     for (let from = 0; ...; from += PAGE) {
//       const { data, error } = await q.range(from, from + PAGE - 1)
//       if (error) break                 // ⛔ leaves the loop with a PARTIAL list
//       ...
//     }
//     return rows                        // ...which no caller can tell from a complete one
//
// CLAUDE.md names it and names the remedy: *"A PAGED read that `break`s on error
// returns a PARTIAL list no caller can distinguish from a complete one. No copy
// exists to grep — the tell is the control-flow keyword. Throw, or carry
// `complete:false`."* It shipped for real in `/sitemap/3.xml` (#28), which
// served **24,000 of 27,246 editions under an HTTP 200**.
//
// ⭐ THE SHARPEST VERSION OF THIS, AND WHY IT IS WORTH A GUARD: the paging loop
// is usually itself a FIX for PostgREST's silent 1,000-row clamp — and
// `if (error) break` reaches the identical outcome by a different route. **The
// fix's own failure mode recreates the bug it fixed.** `fetchJerseyNumbers` in
// `/api/sniper-feed` is exactly that: its comment records that a bare
// `.select()` returned 1,000 of 1,317 and dropped the last ~24 %, and its error
// branch could return the same truncation silently.
//
// ⚠ AND AN EXCLUSION SET FAILS *OPEN*. `fetchRetiredMomentIds` builds a set of
// moments to REMOVE from the feed, so every id a partial walk misses is a
// retired moment that leaks back IN. A short exclusion list is not a smaller
// answer, it is a wronger one.
//
// ── WHAT COUNTS AS RECORDING IT ────────────────────────────────────────────
// Any of these in the same function — all are real remedies, none is a dodge:
//   * a `complete` / `incomplete` / `partial` flag,
//   * a `throw` (what `lib/sitemap-data.ts` does, via `SitemapReadIncomplete`),
//   * a `console.warn`/`console.error` naming the cut-short walk.
//
// ⭐ `app/api/og/insights/panini-squeeze/route.tsx` is the model and passes on
// its own merits rather than by exemption: it breaks on error, then publishes
// ONLY `if (complete && expected != null && seen === expected)` — the walk has
// to have covered the population the count reports.
//
// ── WHAT THIS IS STRUCTURALLY SILENT ABOUT, stated rather than implied ─────
//  1. FUNCTION granularity is approximated by a WINDOW of lines after the
//     `break`, not by parsing. A remedy far from the loop is not seen.
//  2. `return` inside an error branch, which is the same class but is usually a
//     deliberate early-out with its own error contract (51 sites carry it — a
//     ban there would be noise, not a guard).
//  3. Whether the recorded flag is ever READ by the caller. It forces the
//     information to exist; it cannot force anyone to use it.
// ─────────────────────────────────────────────────────────────────────────────

const ROOTS = ["app", "components", "lib", "workers", "supabase/functions", "scripts"]

/** A file that pages at all — the only place this class can live. */
const PAGES = /\.range\(|hasNextPage|endCursor|offset\s*\+=/

/** `if (error) break` / `if (err) { break }` — the control-flow tell. */
const ERROR_BREAK = /if\s*\(\s*(?:\w+\.)?\w*[eE]rr\w*\s*\)\s*(?:\{[^}]{0,200}?)?\bbreak\b/g

/** Any acknowledgement that the walk was cut short. */
const RECORDS = /\bcomplete\b|\bincomplete\b|\bpartial\b|\bthrow\b|console\.(?:warn|error)/i

/**
 * CAPTURE-AND-CHECK is the fourth remedy, and leaving it out made this guard
 * flag the BEST implementation in the tree.
 *
 * ⚠ FOUND BY RUNNING THE FIRST VERSION. `app/api/cron/compute-laliga-pack-ev`
 * writes `if (error) { poolErr = error; break }` and then, under the comment
 * "⛔ A PARTIAL POOL IS NOT A SMALLER POOL", checks `if (poolErr)` and FAILS THE
 * RUN rather than computing EV over whatever arrived. That is exactly the
 * behaviour this guard exists to require, and the first matcher called it an
 * offender — **a guard that punishes its own success**, which CLAUDE.md names
 * directly.
 *
 * So a break that hoists the error into a variable clears the check ONLY IF that
 * variable is read again afterwards. Capturing and never checking is still a hit.
 */
const CAPTURE = /(\w*[eE]rr\w*)\s*=\s*\w*[eE]rror\w*\s*;?\s*break\b/

function capturedAndChecked(around: string, after: string): boolean {
  const m = CAPTURE.exec(around)
  if (!m) return false
  const name = m[1]
  // The captured name must appear again beyond the break — an `if (poolErr)`,
  // a log, a return. A capture nobody reads is not a remedy.
  return new RegExp(`\\b${name}\\b`).test(after)
}

/** How far after the break to look for the acknowledgement. */
const WINDOW = 1600

const OPT_OUT = /paged-partial:\s*intentional/
const OPT_OUT_LOOKBACK = 3

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry === ".next") continue
      walk(full, out)
    } else if (/\.(ts|tsx|mjs|js)$/.test(entry) && !entry.includes(".test.")) {
      out.push(full)
    }
  }
  return out
}

type Hit = { file: string; line: number; text: string }

function offenders(): { pagingFiles: number; hits: Hit[] } {
  const hits: Hit[] = []
  let pagingFiles = 0
  for (const root of ROOTS) {
    for (const full of walk(join(process.cwd(), root))) {
      const raw = readFileSync(full, "utf8")
      // ⚠ Load-bearing: this file quotes `if (error) break` in prose, and several
      // call sites quote it in the comment that explains the fix.
      const stripped = stripComments(raw)
      if (!PAGES.test(stripped)) continue
      pagingFiles++
      const rawLines = raw.split("\n")
      ERROR_BREAK.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = ERROR_BREAK.exec(stripped)) !== null) {
        // The remedy may sit either side of the break (a flag is often declared
        // above the loop), so look both ways within the window.
        const around = stripped.slice(Math.max(0, m.index - WINDOW), m.index + WINDOW)
        const after = stripped.slice(m.index + m[0].length, m.index + m[0].length + WINDOW)
        if (RECORDS.test(around)) continue
        if (capturedAndChecked(stripped.slice(m.index, m.index + 200), after)) continue
        const i = stripped.slice(0, m.index).split("\n").length - 1
        if (isMarkerSuppressed(rawLines, i, OPT_OUT, OPT_OUT_LOOKBACK)) continue
        const file = relative(process.cwd(), full).split(sep).join("/")
        hits.push({ file, line: i + 1, text: (rawLines[i] ?? "").trim().slice(0, 100) })
      }
    }
  }
  return { pagingFiles, hits }
}

describe("a paged read does not break into a silent partial", () => {
  it("the walk reaches paging files at all (not vacuously passing)", () => {
    // ⚠ Asserts the WALK, never the offender count — a threshold on offenders
    // goes red the moment the population reaches zero, which is the point.
    const { pagingFiles } = offenders()
    expect(pagingFiles, "no paging files reached — the walk is broken").toBeGreaterThan(50)
  })

  it("EVERY root contributes files — a root added but not reached is a silent hole", () => {
    for (const r of ROOTS) {
      expect(walk(join(process.cwd(), r)).length, `root "${r}" reached no files`).toBeGreaterThan(0)
    }
  })

  it("the matcher fires on the bare shape and clears on each real remedy", () => {
    const loop = (body: string) =>
      `for (let f = 0; f < 10; f += P) {\n  const { data, error } = await q.range(f, f + P - 1)\n${body}\n}`
    const bare = loop("  if (error) break")
    expect(ERROR_BREAK.test(bare) && !RECORDS.test(bare), "the bare shape must be a hit").toBe(true)

    for (const [name, remedy] of [
      ["a completeness flag", "  if (error) break\n  if (page.length < P) { complete = true; break }"],
      ["a throw", "  if (error) throw new Error('incomplete')"],
      ["a warn that names it", "  if (error) { console.warn('INCOMPLETE walk'); break }"],
    ] as const) {
      const src = loop(remedy)
      expect(RECORDS.test(src), `${name} must clear it`).toBe(true)
    }

    // ⚠ THE FOURTH REMEDY, and the one whose absence made the first version of
    // this guard flag the best implementation in the tree (compute-laliga-pack-ev).
    const captured = "  if (error) { poolErr = error; break }"
    expect(RECORDS.test(captured), "capture-and-check is not caught by the word list").toBe(false)
    expect(
      capturedAndChecked(captured, "if (poolErr) { return fail(poolErr) }"),
      "an error hoisted out of the loop AND read afterwards must clear it",
    ).toBe(true)
    expect(
      capturedAndChecked(captured, "const unrelated = 1"),
      "a capture nobody reads is NOT a remedy",
    ).toBe(false)
  })

  it("the comment stripper is load-bearing (this file would flag itself without it)", () => {
    const doc = "// the shape is: if (error) break\nconst ok = 1"
    ERROR_BREAK.lastIndex = 0
    expect(ERROR_BREAK.test(doc)).toBe(true)
    ERROR_BREAK.lastIndex = 0
    expect(ERROR_BREAK.test(stripComments(doc))).toBe(false)
  })

  it("no paged read returns a partial list without saying so", () => {
    const { pagingFiles, hits } = offenders()
    expect(
      hits.length,
      "A paging loop that breaks out of its error branch leaves a PARTIAL list that no caller\n" +
        "can distinguish from a complete one — the shape that served 24,000 of 27,246 editions\n" +
        "under an HTTP 200 (#28). Worse, the loop is usually itself the FIX for PostgREST's\n" +
        "silent 1,000-row clamp, so this failure mode recreates the bug it fixed.\n" +
        "Throw, carry a `complete` flag, or console.warn naming the cut-short walk.\n" +
        "If a short walk genuinely cannot mislead, say why: add `paged-partial: intentional`\n" +
        `on the flagged line or the ${OPT_OUT_LOOKBACK} lines above it.\n` +
        `(${pagingFiles} paging files inspected)\n` +
        hits.map((h) => `  - ${h.file}:${h.line}  ${h.text}`).join("\n"),
    ).toBe(0)
  })
})

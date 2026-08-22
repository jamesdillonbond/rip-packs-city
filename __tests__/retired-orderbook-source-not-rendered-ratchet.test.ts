import { describe, it, expect } from "vitest"
import { readdirSync, readFileSync } from "node:fs"
import { join, relative, sep } from "node:path"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

// BAN AT ZERO on rendering a `topshot_orderbook` figure without disclosing that
// its source is retired. (deep-audit D12 → D12b)
//
// ── THE DEFECT THIS EXISTS TO STOP RECURRING ────────────────────────────────
// `ts_listings` was switched off with the Top Shot listings-indexer on
// 2026-05-26. It holds exactly ONE row, written 2026-05-15.
// `analytics_listings_summary` still computes a `topshot_orderbook` block from
// it, so any count/median/p90 taken from that block is a percentile over a
// single row that is now ~99 days old.
//
// D12 was closed on `components/analytics/ListingsDashboard.tsx`. The SAME block
// was still rendered by the per-collection analytics tab, which published
// "ORDER BOOK DEPTH · 1 listings · MEDIAN ASK $5.0k · P90 ASK $5.0k" to
// anonymous visitors for three more months. One fix, two surfaces, and the
// register recorded the item RESOLVED.
//
// ── WHY THIS WALKS THE TREE INSTEAD OF NAMING THE TWO KNOWN FILES ───────────
// The entire history of this defect is a fix that reached one of two copies. A
// guard listing the files it knows about would have passed on the day D12b was
// shipping. Derivation fixes blast radius, so the population is whatever the
// walk finds — including a surface added tomorrow.
//
// ── WHY IT IS SATISFIABLE AT ZERO ──────────────────────────────────────────
// If no rendering surface reads the block at all, that is the ideal end state,
// not a guard failure. A check that reddens when it succeeds teaches people to
// delete it.
//
// ⚠ WHAT THIS DOES NOT CLAIM. It asserts the disclosure module is REFERENCED,
// not that the rendered sentence is true — no static check can see that. It
// also says nothing about non-Top-Shot collections, which read
// `marketplace_listings`, a live source, and must keep rendering real numbers.

const ROOTS = ["app", "components"]
const DISCLOSURE_MODULE = "ts-listings-retired"
const TOKEN = "topshot_orderbook"

// ⚠ MIGRATED 2026-08-22 to the ONE shared stripper (scripts/lib/strip-comments.mjs).
//
// This file originally carried its own hand-rolled state machine, written
// because the regex idiom copy-pasted across the suite blanks real source (a
// line comment mentioning a glob path opens a block comment that closes at the
// next close-marker anywhere in the file — register R42).
//
// ⚠ THAT REPLACEMENT WAS ALSO BLIND, and the correction is the lesson: it had
// no REGEX-LITERAL state, so a regex ending in an escaped slash presents a bare
// line-comment marker and blanks the rest of the line — 80 occurrences across
// 66 files, including the guards' own comment-stripping bodies. Writing a
// second stripper to fix the first one reproduced the first one's failure mode.
// Hence: one shared helper, and nobody hand-rolls a 38th copy.
//
// The positive control below now exercises the SHARED helper, which is the only
// way this file can notice if that helper ever regresses.

function* walk(dir: string): Generator<string> {
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    const full = join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === ".next") continue
      yield* walk(full)
    } else if (e.name.endsWith(".tsx")) {
      // .tsx only: rendering surfaces. API routes (`route.ts`) and the shared
      // type module are conduits, not claims — they may name the block freely.
      yield full
    }
  }
}

function offenders(): string[] {
  const bad: string[] = []
  for (const root of ROOTS) {
    for (const full of walk(join(process.cwd(), root))) {
      const raw = readFileSync(full, "utf8")
      if (!stripComments(raw).includes(TOKEN)) continue
      if (raw.includes(DISCLOSURE_MODULE)) continue
      bad.push(relative(process.cwd(), full).split(sep).join("/"))
    }
  }
  return bad
}

describe("retired orderbook source is never rendered as depth (D12b)", () => {
  it("the comment stripper does not swallow code after a `/api/*`-style line comment", () => {
    // POSITIVE CONTROL for the guard's own instrument. If this regresses, the
    // walk above silently returns zero offenders and the guard reads GREEN while
    // measuring nothing — the documented "permanently-zero instrument" failure.
    const sample = [
      "// short form used by /api/* endpoints. Distinct from the long form",
      'const orderbook = data?.topshot_orderbook',
      "/* a real block comment mentioning topshot_orderbook */",
    ].join("\n")
    const stripped = stripComments(sample)
    expect(stripped).toContain("data?.topshot_orderbook")
    expect(stripped.match(/topshot_orderbook/g)).toHaveLength(1)
  })

  it("every .tsx surface reading topshot_orderbook references the retirement disclosure", () => {
    // Satisfiable at a population of zero: no surfaces reading it is the ideal
    // end state and passes.
    expect(offenders()).toEqual([])
  })
})

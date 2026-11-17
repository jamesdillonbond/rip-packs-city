import { describe, it, expect } from "vitest"
import { readdirSync, readFileSync } from "node:fs"
import { join, relative, sep } from "node:path"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

// BAN AT ZERO on rendering a `topshot_orderbook` figure without consulting the
// block's provenance. (deep-audit D12 → D12b, re-pointed 2026-09-20)
//
// ── THE DEFECT THIS EXISTS TO STOP RECURRING ────────────────────────────────
// `ts_listings` was switched off with the Top Shot listings-indexer on
// 2026-05-26, leaving ONE row written 2026-05-15, while
// `analytics_listings_summary` kept computing a `topshot_orderbook` block from
// it — so any count/median/p90 from that block was a percentile over a single
// stale row.
//
// D12 was closed on `components/analytics/ListingsDashboard.tsx`. The SAME block
// was still rendered by the per-collection analytics tab, which published
// "ORDER BOOK DEPTH · 1 listings · MEDIAN ASK $5.0k · P90 ASK $5.0k" to
// anonymous visitors for three more months. One fix, two surfaces, and the
// register recorded the item RESOLVED.
//
// ── AND THEN IT FAILED THE OTHER WAY (2026-09-20) ───────────────────────────
// `ts_listings` was rewired to the Atlas firehose on 2026-09-07 and is rebuilt
// every ~2 min (measured: 60,350 rows over 2,377 editions). The disclosure was
// a pair of hardcoded date constants, so for 13 days the tab suppressed a real
// 60k-row order book in order to tell readers the last row was written on
// 2026-05-15. THIS GUARD STAYED GREEN THROUGHOUT — it asserted the module was
// referenced, and it was.
//
// The lesson is in the second `it` below: the previous version of this guard
// could only ever check that SOMETHING was said, never that the something was
// still true. A disclosure derived from a hardcoded feed-state date is the
// failure mode, so the date constants are now banned outright and the copy is
// driven by the `age_hours` the block publishes about itself.
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
// ⚠ WHAT THIS DOES NOT CLAIM. It asserts the provenance module is REFERENCED
// and that the module derives its verdict rather than hardcoding a feed-state
// date. It cannot check that the rendered sentence is true at render time — the
// only thing that can is the `age_hours` the RPC publishes, which is why the
// verdict was moved there. It also says nothing about non-Top-Shot collections,
// which read `marketplace_listings`, a live source, and must keep rendering
// real numbers.

const ROOTS = ["app", "components"]
const DISCLOSURE_MODULE = "ts-orderbook-freshness"
const PROVENANCE_MODULE_PATH = "lib/analytics/ts-orderbook-freshness.ts"
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

  it("every .tsx surface reading topshot_orderbook references the provenance module", () => {
    // Satisfiable at a population of zero: no surfaces reading it is the ideal
    // end state and passes.
    expect(offenders()).toEqual([])
  })

  it("the provenance module DERIVES its verdict and hardcodes no feed-state date", () => {
    // THE 2026-09-20 LESSON, pinned. The predecessor module decided whether to
    // publish depth from `TS_LISTINGS_RETIRED_ON = "2026-05-26"` and
    // `TS_LISTINGS_LAST_ROW_ON = "2026-05-15"`. When the feed came back those
    // constants silently became false, and nothing in the suite could tell —
    // this very file was green the whole time.
    //
    // A date literal here is therefore banned outright. Historical dates in
    // COMMENTS are fine and wanted (they carry the case history); only live
    // code is inspected, via the shared stripper exercised by the control above.
    const src = stripComments(readFileSync(join(process.cwd(), PROVENANCE_MODULE_PATH), "utf8"))

    const dateLiterals = src.match(/["'`]\d{4}-\d{2}-\d{2}["'`]/g) ?? []
    expect(
      dateLiterals,
      `${PROVENANCE_MODULE_PATH} hardcodes a feed-state date in live code. That is the defect: a ` +
        `date cannot notice its own premise expired. Derive the verdict from the age the block publishes.`,
    ).toEqual([])

    // ...and the derivation it uses instead is actually present. Without this,
    // deleting the whole classifier would pass the ban above.
    expect(src).toContain("classifyTsOrderbook")
    expect(src).toContain("TS_ORDERBOOK_STALE_AFTER_HOURS")
  })

  it("classifyTsOrderbook keeps an unknown age distinct from a fresh one", async () => {
    // The three-state property, asserted as behaviour rather than as spelling.
    // A null age is what the RPC emits when it learned nothing; reading that as
    // `fresh` would republish the original defect with new words.
    const { classifyTsOrderbook, TS_ORDERBOOK_STALE_AFTER_HOURS } = await import(
      "../lib/analytics/ts-orderbook-freshness"
    )
    expect(classifyTsOrderbook(null)).toBe("unknown")
    expect(classifyTsOrderbook(undefined)).toBe("unknown")
    expect(classifyTsOrderbook(Number.NaN)).toBe("unknown")
    expect(classifyTsOrderbook(0)).toBe("fresh")
    expect(classifyTsOrderbook(TS_ORDERBOOK_STALE_AFTER_HOURS)).toBe("fresh")
    expect(classifyTsOrderbook(TS_ORDERBOOK_STALE_AFTER_HOURS + 0.01)).toBe("stale")
    // The shape that actually shipped broken: a feed dark since May.
    expect(classifyTsOrderbook(24 * 120)).toBe("stale")
  })
})

// __tests__/fmv-recalc-has-no-distinct-on-snapshot-walk.test.ts
//
// BAN AT ZERO: no query in `app/api/fmv-recalc/route.ts` may build its
// latest-snapshot-per-edition set with `DISTINCT ON` over `fmv_snapshots`.
//
// ── WHY A GUARD AND NOT A COMMENT: THE SAME DEFECT WAS FIXED FOUR TIMES ────
// `DISTINCT ON (edition_id) … FROM fmv_snapshots ORDER BY edition_id,
// computed_at DESC` walks the WHOLE snapshot history to materialise one row per
// edition, then throws almost all of it away. In this one file it was written
// four separate times:
//
//   · Steps 5c / 5d / 5e — converted to a per-edition LATERAL on 2026-08-31.
//   · Step 6 (stale touch) — left behind, and converted on 2026-09-05.
//
// ⚠ A comment is only read by someone already in the file, and four authors
// were already in this file. That is what a guard is for.
//
// 🚨 STEP 6 IS WHY THIS IS WORTH BANNING RATHER THAN NOTING. Measured
// warm-vs-warm with EXPLAIN (ANALYZE, BUFFERS) on 2026-09-05:
//
//     DISTINCT ON CTE : 1,390,030 buffers / 27,248 ms
//     LATERAL LIMIT 1 :   138,788 buffers /  2,055 ms      (−90%, 13.3×)
//
// The `Unique` node walked 1,429,511 rows to emit 27,849, and the outer filter
// then discarded 27,844 of those — 1.39 MILLION buffers to return ZERO rows.
// ⛔ And 27.2 s sits against the 30 s `statement_timeout`, so it was KILLED on
// **27 of the 460 runs that executed it (5.9%)** in the 73 h to 2026-09-05 —
// under `ok = true`, because the step records its failure in
// `extra.stale_touch_error` while the run still reports success. A defect that
// costs a million buffers AND fails silently is exactly the kind that survives.
//
// ── WHAT THIS DOES NOT CLAIM ──────────────────────────────────────────────
// ⛔ `DISTINCT ON` is not banned generally and is often the right tool. The ban
// is narrow on purpose: a `DISTINCT ON` in a query that reads `fmv_snapshots`,
// in THIS route. That is the shape with a measured replacement.
//
// ⚠ It is satisfiable at a population of ZERO, which it is today — the guard
// does not punish its own success, and it names no instances, so a rename
// cannot kill it.

import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "../scripts/lib/strip-comments.mjs"
import { stripSqlComments } from "../scripts/lib/strip-sql-comments.mjs"

const ROUTE = join(process.cwd(), "app", "api", "fmv-recalc", "route.ts")

/**
 * Every backtick-delimited template literal in the source.
 *
 * ⚠ THE SQL IS READ OUT OF THE TEMPLATE LITERALS, NOT OFF THE RAW FILE, and
 * that is deliberate in both directions:
 *   · Running a SQL comment stripper over raw TypeScript would treat a JS
 *     decrement (`i--`) as the start of a SQL line comment and BLANK the rest
 *     of the line. For a ban, hiding code is the dangerous direction — it makes
 *     the guard pass by blindness.
 *   · Grepping the raw file instead trips on this header, which NAMES the
 *     banned shape in order to explain it. A guard satisfied (or fired) by its
 *     own documentation is a recorded failure mode in this repo.
 *
 * 🚨 JS COMMENTS ARE STRIPPED FIRST, AND THE FIRST DRAFT OF THIS GUARD WAS WRONG
 * FOR EXACTLY THE REASON IT EXISTS TO CATCH. A naive backtick scan
 * desynchronises on a backtick that lives inside a `//` comment — and the route
 * has one, in the note explaining the 2026-08-31 conversion. From that backtick
 * on, every "literal" boundary was off by one, and the guard reported an
 * offender that was pure prose. Same shape as the stripper defects fixed the
 * same night: an unpaired delimiter inside commentary swallowing real code.
 */
export function templateLiterals(rawSrc: string): string[] {
  // ⚠ ASSERTED, NOT ASSUMED. CLAUDE.md records the shared stripper being trusted
  // blind three separate times — "USING it is not a guarantee it stripped". If it
  // ever fails on this file the ban would silently pass on a blanked source, so
  // the caller checks the strip landed before believing any result derived from it.
  const src = stripComments(rawSrc) as string
  const out: string[] = []
  let i = 0
  while (i < src.length) {
    if (src[i] === "\\") {
      i += 2
      continue
    }
    if (src[i] === "`") {
      const start = i + 1
      i += 1
      while (i < src.length && src[i] !== "`") {
        if (src[i] === "\\") i += 1
        i += 1
      }
      out.push(src.slice(start, i))
      i += 1
      continue
    }
    i += 1
  }
  return out
}

/** Literals that are SQL against `fmv_snapshots`, with SQL comments blanked. */
function snapshotQueries(src: string): string[] {
  return templateLiterals(src)
    .map((lit) => stripSqlComments(lit) as string)
    .filter((sql) => /\bfmv_snapshots\b/i.test(sql))
}

describe("fmv-recalc builds its latest-snapshot set with a LATERAL, never a DISTINCT ON walk", () => {
  const src = readFileSync(ROUTE, "utf8")

  it("THE STRIPPER ACTUALLY STRIPPED — the ban is worthless on a blanked source", () => {
    const stripped = stripComments(src) as string
    // Offsets preserved, so a desync is visible as a length change.
    expect(stripped.length).toBe(src.length)
    // A phrase that exists ONLY inside a JS // comment must be gone...
    expect(src).toContain("These three steps each used")
    expect(stripped).not.toContain("These three steps each used")
    // ...and live SQL must SURVIVE. Without this, a stripper that blanked the
    // whole file would satisfy the ban below by hiding everything.
    // ⚠ The canary is a CTE NAME, not the LATERAL spelling. An earlier draft used
    // "CROSS JOIN LATERAL" here, which coupled this stripper check to the exact
    // shape the OTHER tests assert — so a mutation to that shape reddened this
    // test too, for a reason that has nothing to do with stripping.
    expect(stripped).toContain("WITH cand AS")
    expect(stripped).toContain("recent_traded")
  })

  it("inspected a non-trivial number of SQL literals", () => {
    // A walk that silently finds nothing exits clean and reads as coverage.
    // If the route is ever refactored so its SQL no longer lives in template
    // literals, this reds and says so instead of passing vacuously.
    expect(snapshotQueries(src).length).toBeGreaterThanOrEqual(3)
  })

  it("BAN AT ZERO — no query reading fmv_snapshots uses DISTINCT ON", () => {
    const offenders = snapshotQueries(src).filter((sql) => /DISTINCT\s+ON/i.test(sql))
    expect(
      offenders.length,
      "A DISTINCT ON walk over fmv_snapshots is back. It materialises one row per\n" +
        "edition from the WHOLE snapshot history and then discards nearly all of it:\n" +
        "measured 1,390,030 buffers / 27,248 ms against 138,788 / 2,055 ms for the\n" +
        "per-edition LATERAL, and at 27.2s it was killed by the 30s statement_timeout\n" +
        "on 5.9% of runs — silently, under ok=true.\n" +
        "Use: CROSS JOIN LATERAL (SELECT ... FROM fmv_snapshots fs\n" +
        "     WHERE fs.edition_id = c.edition_id ORDER BY fs.computed_at DESC LIMIT 1)\n" +
        "⚠ Keep the freshness/confidence filters OUTSIDE the LATERAL — moving them in\n" +
        "changes the meaning, picking the newest OLD snapshot for an edition that also\n" +
        "has a fresh one.",
    ).toBe(0)
  })

  it("POSITIVE CONTROL — the detector fires on the banned shape", () => {
    // Without this the ban above could pass because the extractor is broken.
    const rolled = ["const q = `", "  SELECT DISTINCT ON (fs.edition_id) fs.fmv_usd", "  FROM fmv_snapshots fs", "`"].join("\n")
    expect(snapshotQueries(rolled).filter((s) => /DISTINCT\s+ON/i.test(s)).length).toBe(1)
  })

  it("NEGATIVE CONTROL — a DISTINCT ON over a DIFFERENT table is not banned", () => {
    // The ban is narrow by design: DISTINCT ON is frequently correct.
    const other = ["const q = `", "  SELECT DISTINCT ON (s.edition_id) s.price_usd FROM sales s", "`"].join("\n")
    expect(snapshotQueries(other).length).toBe(0)
  })

  it("NEGATIVE CONTROL — the banned phrase inside a SQL COMMENT does not count", () => {
    // This file's own subject matter guarantees the shipped route explains the
    // shape it replaced. A guard that fired on that explanation would train the
    // next author to delete the explanation.
    const documented = ["const q = `", "  -- replaced the DISTINCT ON walk over fmv_snapshots", "  SELECT 1 FROM fmv_snapshots", "`"].join("\n")
    expect(documented.includes("DISTINCT ON")).toBe(true)
    expect(snapshotQueries(documented).filter((s) => /DISTINCT\s+ON/i.test(s)).length).toBe(0)
  })

  it("EVERY query reading fmv_snapshots uses a LATERAL — a ban alone would accept DELETION", () => {
    // ⚠ A ban is satisfied by REMOVING the query, so on its own it cannot tell a
    // fix from a deletion. This asserts the replacement is actually there.
    //
    // ⚠ It asserts the PROPERTY, not a COUNT. "every snapshot query uses a
    // LATERAL" survives a step being legitimately added or retired, whereas a
    // pinned number dies on the next refactor and gets bumped without thought.
    //
    // ⚠ And it matches LATERAL generally, not `CROSS JOIN LATERAL`. Steps 5c/5d/5e
    // use `LEFT JOIN LATERAL` and are equally correct; an earlier draft demanded
    // the CROSS spelling and reported three correct queries as missing — the
    // guard-pins-a-SPELLING failure this repo has recorded before.
    const queries = snapshotQueries(src)
    const withoutLateral = queries.filter((sql) => !/\bLATERAL\b/i.test(sql))
    expect(withoutLateral.length, "a query reads fmv_snapshots without a per-edition LATERAL").toBe(0)
    expect(queries.length).toBeGreaterThanOrEqual(3)
  })
})

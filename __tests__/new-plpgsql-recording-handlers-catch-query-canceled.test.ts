// __tests__/new-plpgsql-recording-handlers-catch-query-canceled.test.ts
//
// BAN AT ZERO, FORWARD ONLY: a migration applied after R118 may not introduce a
// plpgsql exception handler that (a) exists to RECORD a failure and (b) cannot see
// the only failure this instance actually produces — a statement_timeout kill.
//
// ── THE DEFECT ─────────────────────────────────────────────────────────────────
// PostgreSQL: "the special condition name OTHERS matches every error type EXCEPT
// QUERY_CANCELED and ASSERT_FAILURE", and a `statement_timeout` raises exactly
// `query_canceled` (57014). So `EXCEPTION WHEN OTHERS THEN <write a pipeline_runs
// row / write the 999 sentinel>` is structurally incapable of firing on the one
// failure it was written for. R118 (2026-09-20) found 49 plpgsql functions using
// `WHEN OTHERS`, exactly ONE naming `query_canceled`, and 12 whose own comments
// CLAIMED they handled timeouts. It rewrote 35 of them across four migrations.
//
// The user-facing half: a killed 6-hourly trust leg left its metric frozen and
// `v_rpc_trust_health` republished it as current — it has no per-metric age column
// and its only staleness rule is `computed_at < now() - 24h -> 999`, so a stale
// value published as current could survive ~18 h with no tell.
//
// ── WHY A GUARD AND NOT A COMMENT ──────────────────────────────────────────────
// This is the fourth time the same PL/pgSQL fact has had to be re-established here
// (2026-08-15 trust board, 2026-08-26 promoted to database.md, 2026-09-20 R118),
// and in between, `refresh_series_detail_rollup` shipped a handler whose stated
// purpose was "Isolated so it cannot take the job down" — blind to the only error
// that job has ever had. A comment is only read by someone already in the file,
// and every author who wrote one of these was already in the file.
//
// ── WHY IT IS FORWARD-ONLY, AND WHY THAT IS NOT AN ALLOWLIST ───────────────────
// `supabase/migrations/` is immutable history: >1,100 files, many carrying bodies
// that were superseded years-of-commits ago. Scanning all of them would be red
// forever, and a permanently-red instrument is indistinguishable from a broken one.
// The window is therefore a DATE, not a list of excused instances: every migration
// after R118's last one is in scope, and the cutoff cannot rot per-instance or die
// on a rename the way a named allowlist does. The live estate is covered from the
// other side by `check_when_others_timeout_blind()` in the database.
//
// ── WHAT THIS DOES NOT CLAIM ───────────────────────────────────────────────────
// ⛔ `WHEN OTHERS` is NOT banned generally, and 14 functions are deliberately still
// on it — mostly handlers inside LOOPs, where catching the cancel would let the
// remaining iterations run unbounded. That is the rule working, not a gap.
// ⛔ This guard cannot see the failure mode that the fix itself introduces: after a
// cancel is caught the timer is NOT re-armed (re-measured 2026-09-20 — a 2 s sleep
// after the catch ran to completion under a 700 ms budget), so anything ADDED to a
// handler that catches `query_canceled` runs with no timeout at all. Neither this
// guard nor `check_when_others_timeout_blind()` detects an UNBOUNDED handler tail.
// That one is still read by eye. See docs/reference/database.md.
//
// ⚠ Satisfiable at a population of ZERO — it does not punish its own success — and
// it names no instances, so a rename cannot kill it. Because a zero population
// would otherwise make it silent, it ASSERTS the count it inspected and carries its
// own positive control below: a guard nobody has seen fail is indistinguishable
// from one that inspects nothing.

import { describe, expect, it } from "vitest"
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { stripSqlComments } from "../scripts/lib/strip-sql-comments.mjs"
import { isMarkerSuppressed } from "../scripts/lib/marker-suppression.mjs"

const MIGRATIONS = join(process.cwd(), "supabase", "migrations")

// R118's last migration (20260920144120, the check_when_others_timeout_blind
// instrument). Everything strictly after it is in scope.
const CUTOFF = "20260920144120"

// The inline escape hatch, read off the RAW lines. Use it on a handler whose tail
// is genuinely unbounded (a LOOP), where catching the cancel is the worse trade.
//
// ⚠ TWO THINGS ABOUT THE SHARED READER THAT BITE ON A .sql FILE, both found by
// planting a real migration and watching the hatch fail to open:
//   1. `isMarkerSuppressed` calls `marker.test(...)`, so the marker MUST be a
//      RegExp. A string silently has no `.test` and the call throws.
//   2. Its contiguous-comment-block walk recognises `//`, `*` and `/*` — the
//      JAVASCRIPT prefixes. A SQL `--` comment is not one, so on a migration ONLY
//      the fixed lookback window applies. Hence the explicit, larger LOOKBACK
//      below: a justification worth honouring runs to a few lines, and the
//      helper's own history records suppressions SILENTLY IGNORED for exactly
//      this reason.
const MARKER = /when-others-timeout-blind:\s*intentional/i
const LOOKBACK = 8

/** A body is in scope only if its handler exists to RECORD a failure. */
const RECORDING = [/log_pipeline_run/i, /statement_timeout/i, /\b57014\b/, /\b999\b/]

type Violation = { file: string; fn: string; conds: string }

/**
 * Extract `CREATE OR REPLACE FUNCTION|PROCEDURE <name> ... $tag$ body $tag$` pairs.
 * Mirrors the extractor in db-invariants-drift-guard (FUNCTION **and** PROCEDURE —
 * a FUNCTION-only needle once made every PROCEDURE in this database unpinnable).
 */
function plpgsqlBodies(src: string): { fn: string; body: string; at: number }[] {
  const out: { fn: string; body: string; at: number }[] = []
  const re = /CREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|PROCEDURE)\s+([A-Za-z0-9_."]+)/gi
  for (const m of src.matchAll(re)) {
    const start = m.index ?? 0
    const rest = src.slice(start)
    const tag = /\$([a-zA-Z_]*)\$/.exec(rest)
    if (!tag) continue
    const open = tag.index + tag[0].length
    const close = rest.indexOf(tag[0], open)
    if (close < 0) continue
    // Only plpgsql — a SQL-language body has no exception handlers at all.
    if (!/LANGUAGE\s+plpgsql/i.test(rest.slice(0, open))) continue
    out.push({ fn: m[1], body: rest.slice(open, close), at: start })
  }
  return out
}

/**
 * Handler regions blind to a cancel.
 *
 * Each `EXCEPTION` keyword opens a region that runs to the next `EXCEPTION` (or the
 * end of the body). A region is BLIND when it has a `WHEN … OTHERS … THEN` clause
 * and no clause anywhere in it names `query_canceled`, so `WHEN query_canceled THEN
 * … WHEN OTHERS THEN …` — two handlers, cancel handled first — correctly passes.
 *
 * ⚠ Known limitation, stated rather than hidden: regions are split on `EXCEPTION`,
 * not brace-matched, so a nested block's `query_canceled` can mask an enclosing bare
 * handler in the same region. That direction is a FALSE NEGATIVE (it under-reports),
 * never a false alarm — chosen deliberately, because a guard that cries wolf on
 * valid SQL gets deleted.
 */
function blindRegions(body: string): string[] {
  const sql = stripSqlComments(body)
  if (!RECORDING.some((r) => r.test(sql))) return []
  const parts = sql.split(/\bEXCEPTION\b/i).slice(1)
  const bad: string[] = []
  for (const region of parts) {
    const clauses = [...region.matchAll(/\bWHEN\b([\s\S]{0,200}?)\bTHEN\b/gi)].map((c) => c[1])
    if (clauses.length === 0) continue
    const namesCancel = clauses.some((c) => /query_canceled/i.test(c))
    const others = clauses.find((c) => /\bOTHERS\b/i.test(c))
    if (others !== undefined && !namesCancel) bad.push(others.trim().replace(/\s+/g, " "))
  }
  return bad
}

function migrationsInScope(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .filter((f) => {
      const v = /^(\d{14})_/.exec(f)
      return v !== null && v[1] > CUTOFF
    })
    .sort()
}

describe("a migration after R118 may not add a recording handler blind to a timeout kill", () => {
  const files = migrationsInScope()

  it("the scan actually ran — the migrations tree is readable and non-empty", () => {
    // THE TELL IS SILENCE. A guard that normally states its count and then says
    // nothing has not passed, it has not spoken: a bad path or a moved directory
    // would otherwise make this whole file a green no-op.
    const all = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql"))
    expect(all.length).toBeGreaterThan(1000)
    console.log(
      `[when-others guard] ${all.length} migration file(s) on disk, ` +
        `${files.length} after the R118 cutoff ${CUTOFF} and therefore in scope`,
    )
  })

  it("no in-scope migration introduces a blind recording handler", () => {
    const violations: Violation[] = []
    for (const file of files) {
      const src = readFileSync(join(MIGRATIONS, file), "utf8")
      const rawLines = src.split("\n")
      for (const { fn, body, at } of plpgsqlBodies(src)) {
        const blind = blindRegions(body)
        if (blind.length === 0) continue
        // The marker lives in a comment, so it is read off the RAW lines, never a
        // comment-stripped copy. Anchored at the declaration, which is the line a
        // reviewer meets.
        const line = src.slice(0, at).split("\n").length - 1
        if (isMarkerSuppressed(rawLines, line, MARKER, LOOKBACK)) continue
        for (const conds of blind) violations.push({ file, fn, conds })
      }
    }
    expect(
      violations,
      violations.length === 0
        ? ""
        : "these new plpgsql handlers record a failure but cannot see a statement_timeout kill " +
          `(57014 escapes \`WHEN OTHERS\`). Name query_canceled — \`WHEN query_canceled OR OTHERS THEN\` ` +
          `— or, if the handler tail is unbounded (a LOOP), add \`${MARKER}\` in a comment above it ` +
          "with the reason:\n" +
          violations.map((v) => `  ${v.file}  ${v.fn}  (WHEN ${v.conds} THEN)`).join("\n"),
    ).toEqual([])
  })
})

describe("the detector itself is not vacuous", () => {
  // Guards the guard. Without these, narrowing any predicate above would simply
  // make the walk find nothing and read as a pass — the exact shape CLAUDE.md
  // warns about ("a passing guard nobody has seen fail is indistinguishable from
  // one that inspects nothing").
  const wrap = (body: string) =>
    `CREATE OR REPLACE FUNCTION public.zz_probe() RETURNS void LANGUAGE plpgsql AS $fn$${body}$fn$;`

  const BLIND = `
DECLARE v int;
BEGIN
  BEGIN
    SELECT 1 INTO v;
  EXCEPTION WHEN OTHERS THEN
    PERFORM public.log_pipeline_run('probe', false);
  END;
END;`

  it("FIRES on a recording handler that only names OTHERS", () => {
    const [b] = plpgsqlBodies(wrap(BLIND))
    expect(blindRegions(b.body)).toHaveLength(1)
  })

  it("is CLEAN once the handler names query_canceled", () => {
    const fixed = BLIND.replace("WHEN OTHERS THEN", "WHEN query_canceled OR OTHERS THEN")
    const [b] = plpgsqlBodies(wrap(fixed))
    expect(blindRegions(b.body)).toEqual([])
  })

  it("is CLEAN for a separate `WHEN query_canceled THEN … WHEN OTHERS THEN …` pair", () => {
    const pair = BLIND.replace(
      "EXCEPTION WHEN OTHERS THEN",
      "EXCEPTION WHEN query_canceled THEN RAISE; WHEN OTHERS THEN",
    )
    expect(blindRegions(plpgsqlBodies(wrap(pair))[0].body)).toEqual([])
  })

  it("IGNORES a handler that records nothing — the ban is narrow on purpose", () => {
    const quiet = BLIND.replace("PERFORM public.log_pipeline_run('probe', false);", "v := 0;")
    expect(blindRegions(plpgsqlBodies(wrap(quiet))[0].body)).toEqual([])
  })

  it("IGNORES a commented-out handler, so a migration's prior-version note is not a violation", () => {
    const commented = BLIND.split("\n")
      .map((l) => (l.includes("WHEN OTHERS") ? `-- ${l}` : l))
      .join("\n")
    expect(blindRegions(plpgsqlBodies(wrap(commented))[0].body)).toEqual([])
  })

  it("skips a non-plpgsql body outright", () => {
    const sqlFn = `CREATE OR REPLACE FUNCTION public.zz_sql() RETURNS int LANGUAGE sql AS $fn$ SELECT 1 $fn$;`
    expect(plpgsqlBodies(sqlFn)).toEqual([])
  })

  it("the ESCAPE HATCH actually opens on a SQL comment — it silently did not, once", () => {
    // ⚠ THIS ARM EXISTS BECAUSE THE HATCH SHIPPED BROKEN IN DRAFT. The marker was a
    // string (the shared reader calls `marker.test`), and the reader's block walk
    // only knows JS comment prefixes, so a `--` justification above a CREATE was
    // ignored. Both failures were SILENT in the direction that matters: the guard
    // stayed red while the author believed the marker had taken — the same shape
    // the reader's own header records from 2026-09-07. Assert the hatch OPENS.
    const lines = [
      "-- This handler's tail is a LOOP, so catching the cancel would let the",
      "-- remaining iterations run with no timeout at all.",
      `-- ${"when-others-timeout-blind: intentional"}`,
      "CREATE OR REPLACE FUNCTION public.zz_probe() RETURNS void LANGUAGE plpgsql AS $fn$",
    ]
    expect(isMarkerSuppressed(lines, 3, MARKER, LOOKBACK)).toBe(true)
    // …and does NOT open for an unmarked declaration.
    expect(isMarkerSuppressed(lines.slice(0, 2).concat(lines[3]), 2, MARKER, LOOKBACK)).toBe(false)
  })

  it("extracts a PROCEDURE, not only a FUNCTION", () => {
    const proc = `CREATE OR REPLACE PROCEDURE public.zz_p() LANGUAGE plpgsql AS $fn$${BLIND}$fn$;`
    expect(plpgsqlBodies(proc)).toHaveLength(1)
    expect(blindRegions(plpgsqlBodies(proc)[0].body)).toHaveLength(1)
  })
})

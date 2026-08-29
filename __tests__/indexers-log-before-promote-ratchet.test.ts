// A sales indexer must write its OWN pipeline_runs row BEFORE it calls
// promote_unmapped_sales — otherwise it bills another pipeline's work to itself.
//
// ── WHY THIS EXISTS ────────────────────────────────────────────────────────
// `pipeline_runs.duration_ms` is a GENERATED column over
// (finished_at - started_at), and `log_pipeline_run` stamps `finished_at` with
// `clock_timestamp()` at INSERT time. The caller supplies `p_started_at` at its
// own entry. So EVERYTHING awaited between entry and that insert lands inside
// the recorded duration, whether or not it is this pipeline's work.
//
// All three sales indexers awaited `promote_unmapped_sales` first, inside the
// same `finally` block. Measured over 24 h to 2026-08-29:
//
//   allday-sales-indexer    recorded avg 50,450 ms · true 6,491 ms · 87.1% foreign
//                           (max single-run inflation 125,972 ms)
//   golazos-sales-indexer   recorded avg  7,544 ms · true 4,202 ms · 44.3% foreign
//   ufc-sales-indexer       logs no elapsed_ms — structurally identical, unmeasured
//
// "true" is `extra.elapsed_ms`, which each route sets BEFORE the finally block —
// so the honest number was already sitting in the same row, next to the wrong one.
// ⚠ That is what makes this class dangerous: nothing looks broken. Any
// duration-ranked board, alert or audit reading allday-sales-indexer at ~50 s was
// reading `promote_unmapped_sales`, and CLAUDE.md already records one ranking
// exercise being sorted by exactly this kind of contamination.
//
// ⭐ Logging first is also strictly better for kill survival: a `maxDuration` kill
// during a 297-second promote used to lose the indexer's row entirely.
//
// ── WHY A TREE WALK AND NOT A NAMED LIST ──────────────────────────────────
// The population is DERIVED on every run — every route that calls both RPCs — so
// a fourth indexer added later is covered the day it lands, and a rename cannot
// quietly empty the check. The inspected count is asserted so the walk cannot
// pass by looking at nothing (this repo has shipped a guard that inspected zero
// files and exited 0).
//
// ⚠ It deliberately matches the CALL EXPRESSION (`rpc("name"`), not the bare
// name, so it needs no comment-stripping pass to avoid matching prose — including
// the explanatory comments this change added at each call site, which name both
// RPCs. `scripts/lib/strip-comments.mjs` has been blind three times; a check that
// does not need it cannot inherit that failure.
//
// ── THE SCOPE IS A PROPERTY, NOT A NAME LIST, AND THE WALK PROVED WHY ─────
// The first version of this guard checked every route calling both RPCs and
// immediately flagged a FOURTH file my hand-picked list had missed:
// app/api/admin/recover-v1-budget-exhausted/route.ts. ⭐ But that one is NOT a
// defect — draining newly-promotable rows IS that route's stated purpose, so
// billing the promote to it is correct. Exempting it BY NAME would have been the
// fragile move this repo has been bitten by three times (a guard that names its
// instances dies on a rename).
//
// The real discriminator is structural: **a promote awaited inside a `finally`
// block is cleanup, and cleanup must not be billed to the pipeline being
// measured.** A promote in the route's main body is the route's own work. So the
// population below is "routes that call promote_unmapped_sales from inside a
// finally", derived on every run, and `recover-v1-budget-exhausted` drops out
// because it has no `finally` at all — by what it IS, not by being listed.

import { describe, expect, it } from "vitest"
import { readFileSync, readdirSync, statSync } from "node:fs"
import path from "node:path"

const API_ROOT = path.join(process.cwd(), "app/api")

function walkRoutes(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walkRoutes(full))
    else if (entry === "route.ts") out.push(full)
  }
  return out
}

const LOG_CALL = 'rpc("log_pipeline_run"'
const PROMOTE_CALL = 'rpc("promote_unmapped_sales"'

type Offender = { file: string; logAt: number; promoteAt: number }

const FINALLY = "} finally {"

const routes = walkRoutes(API_ROOT)
const callsBoth = routes
  .map((f) => ({ f, src: readFileSync(f, "utf8") }))
  .filter(({ src }) => src.includes(LOG_CALL) && src.includes(PROMOTE_CALL))

// Cleanup-path promotes only: the promote call must sit after some `} finally {`.
const population = callsBoth.filter(({ src }) => {
  const finallyAt = src.indexOf(FINALLY)
  return finallyAt !== -1 && src.indexOf(PROMOTE_CALL) > finallyAt
})

describe("sales indexers log their own duration before promoting unmapped sales", () => {
  it("inspected a non-empty population of routes that call BOTH RPCs", () => {
    // Guards the vacuous case: a moved directory or a renamed RPC would otherwise
    // make the assertion below pass by examining nothing at all.
    expect(routes.length).toBeGreaterThan(50)
    // Both counts are asserted: the wider set (calls both RPCs) and the narrower
    // one this guard actually judges (promote on a cleanup path). If the second
    // ever collapses to the first, the structural exemption has stopped working.
    expect(callsBoth.length).toBeGreaterThanOrEqual(4)
    expect(population.length).toBeGreaterThanOrEqual(3)
    expect(population.length).toBeLessThan(callsBoth.length)
  })

  it("has zero routes where promote_unmapped_sales is awaited before log_pipeline_run", () => {
    const offenders: Offender[] = []
    for (const { f, src } of population) {
      // The FIRST occurrence of each is what decides the recorded duration: the
      // earliest log write closes the measurement window.
      const logAt = src.indexOf(LOG_CALL)
      const promoteAt = src.indexOf(PROMOTE_CALL)
      if (promoteAt < logAt) {
        offenders.push({ file: path.relative(process.cwd(), f), logAt, promoteAt })
      }
    }
    expect(
      offenders,
      `these routes await promote_unmapped_sales before writing their own pipeline_runs row, ` +
        `so their duration_ms measures the promote and not the indexer:\n` +
        offenders.map((o) => `  ${o.file}`).join("\n"),
    ).toEqual([])
  })
})

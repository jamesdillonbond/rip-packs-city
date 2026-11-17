// lib/pipeline/route-walls.ts
//
// Map each API route to its `maxDuration` wall and the pipeline name(s) it
// writes under.
//
// ── WHY THIS EXISTS (2026-09-03) ───────────────────────────────────────────
// `lib/pipeline/kill-rate.ts` scores a tick `killed` when no terminal row
// correlates to its marker. That is the right test for the common case and it
// has a MEASURED blind spot: on 2026-09-03 a tick of `cron/evm-transfers-ingest`
// carried a Vercel `Task timed out after 60 seconds` AND a marker AND a terminal
// row with `ok = true`, `duration_ms = 60,464` against a 60,000 ms wall. The
// terminal write raced the wall and won, so the correlation scored it healthy.
//
// The discriminator is already in the row — `duration_ms` at or beyond the
// ROUTE'S OWN wall — and the reason it was not wired in is that the classifier
// had no per-route wall to compare against. This module is that missing half.
//
// ⛔ AND THE CHEAP SUBSTITUTE IS REFUTED, THREE OF THREE, so do not reintroduce
// it. Joining durations against a set of KNOWN wall values (30/60/120/300/800 s)
// produces a large confident table that measures the wrong thing:
//
//   pipeline                                  matched   REAL maxDuration
//   wallet-backfill-multicollection-complete    120 s          800 s
//   wallet-backfill-golazos                      30 s           60 s
//   fmv-recalc                                   60 s          300 s
//
// The clustering just above a round number is the route's INTERNAL budget
// working — the opposite of a kill. A wall is per route and knowable only by
// reading the route.
//
// ── WHAT THIS DOES NOT DO ──────────────────────────────────────────────────
// ⚠ It reads SOURCE, so it describes the tree as committed, not as deployed.
// ⚠ A route whose pipeline name is computed (a variable, a template, a value
//   from a config object it imports) yields NO name, and those routes are
//   RETURNED with an empty `pipelines` array rather than dropped — an unmapped
//   route must be visible as unmapped, or a partial map reads as a complete one.
//   That is the same rule the paged-read guard states: carry `complete:false`.

/** One API route, as far as the wall question is concerned. */
export interface RouteWall {
  /** Repo-relative, forward slashes. */
  rel: string
  /** `export const maxDuration = N` in seconds, or null when the route sets none. */
  maxDurationSec: number | null
  /** Pipeline names this route writes under. Empty when none could be extracted. */
  pipelines: string[]
}

/**
 * Extract `maxDuration` and pipeline name literals from one route's source.
 *
 * ⚠ Pass source with comments already stripped. Every one of these patterns
 * matches prose as readily as code — this repo's route headers quote pipeline
 * names constantly, and `scripts/lib/strip-comments.mjs` exists for exactly
 * this. Not stripping would invent pipelines out of documentation.
 */
export function extractRouteWall(rel: string, strippedCode: string): RouteWall {
  const wall = strippedCode.match(/export\s+const\s+maxDuration\s*=\s*([0-9_]+)/)
  const names = new Set<string>()

  // The three shapes in use, in order of how load-bearing they are:
  //   const PIPELINE = "x" / const PIPELINE_NAME = "x"   (module constant)
  //   pipelineName: "x"                                   (a CONFIG object)
  //   p_pipeline: "x"                                     (the RPC call itself)
  // ⚠ The last one is the ground truth and the first two are conventions, but
  // the RPC argument is usually a variable, so all three are needed and the
  // union is what this returns.
  for (const m of strippedCode.matchAll(/\bPIPELINE(?:_NAME)?[A-Z_]*\s*=\s*["'`]([a-z0-9][a-z0-9-]*)["'`]/g)) {
    names.add(m[1])
  }
  for (const m of strippedCode.matchAll(/\bpipelineName\s*:\s*["'`]([a-z0-9][a-z0-9-]*)["'`]/g)) {
    names.add(m[1])
  }
  for (const m of strippedCode.matchAll(/\bp_pipeline\s*:\s*["'`]([a-z0-9][a-z0-9-]*)["'`]/g)) {
    names.add(m[1])
  }

  return {
    rel,
    maxDurationSec: wall ? Number(wall[1].replace(/_/g, '')) : null,
    pipelines: [...names].sort(),
  }
}

/**
 * How close a recorded run came to its route's wall, as a fraction.
 *
 * `null` when the wall is unknown — NEVER 0 and never 1. A missing wall is an
 * unanswered question, and returning a number here would let a caller sort an
 * unmeasured route among measured ones, which is the fabricated-measurement
 * shape this repo bans at the source (`?? 0` on a count).
 */
export function wallFraction(durationMs: number | null, maxDurationSec: number | null): number | null {
  if (maxDurationSec == null || durationMs == null) return null
  if (maxDurationSec <= 0) return null
  return durationMs / (maxDurationSec * 1000)
}

/**
 * Above this fraction of its own wall, a recorded maximum is evidence that the
 * distribution is CENSORED — the runs that would have exceeded the wall wrote no
 * row at all, so the observed max cannot exceed the ceiling however often the
 * ceiling is hit.
 *
 * ⚠ 0.95 is a reading aid, not a threshold with a false-positive rate behind it.
 * The evidence it is set from: `wallet-backfill-golazos` measured max 59,801 ms
 * against a 60,000 ms wall — **0.997** — over 1,621 runs, while Vercel
 * independently logged 6 `Task timed out` on it in 24 h. The number to trust is
 * the fraction itself; this constant only decides what gets printed in bold.
 */
export const CENSORED_AT = 0.95

/**
 * 🚨 HOW TO READ A FRACTION FAR ABOVE 1 — IT IS THE MAP FAILING, NOT THE ROUTE
 * DYING, AND THE INSTRUMENT IS SELF-DIAGNOSING ABOUT IT.
 *
 * A route cannot record a run longer than its own wall by much: the platform
 * terminates it. So a pipeline reading 2×, 3× or 21× its mapped wall is telling
 * you that **the route you mapped is not the thing writing those rows** — the
 * name is shared with another writer, or the work moved.
 *
 * ⭐ CONFIRMED, not inferred, on the first fleet sweep (2026-09-03, 116 mapped
 * pipelines over the 73 h `pipeline_runs` retains):
 *
 *   pipeline                        wall   max        frac    what it actually is
 *   topshot-active-listings-ingest   60 s  1,303,432 ms 21.7  another writer
 *   refresh-pack-grail-metrics-mv    60 s    163,382 ms  2.7  MOVED TO pg_cron —
 *     migration 20260829235752 "grail mv refresh moves to pg_cron with catchable
 *     terminal row" says so by name, so the Vercel route's wall stopped being
 *     that pipeline's ceiling on 2026-08-29
 *   snapshot-institutional-wallets   30 s     73,528 ms  2.5  another writer
 *   allday-badge-ingest              60 s    112,689 ms  1.9  another writer
 *
 * ⚠ THE INTERESTING BAND IS JUST ABOVE 1, NOT FAR ABOVE IT. `fmv-recalc` 1.058
 * and `evm-transfers-ingest` 1.008 are consistent with a terminal write RACING
 * the wall and winning — and for the evm row there is independent confirmation:
 * Vercel logged `Task timed out after 60 seconds` on that exact invocation.
 *
 * ⚠ And just BELOW 1 is the censored-maximum band: `resolve-topshot-stubs`
 * 0.977, `allday-lock-refresh` 0.974, `wallet-backfill` 0.892. Those maxima
 * cannot exceed the ceiling however often it is hit.
 *
 * ⛔ So this map is NECESSARY AND NOT SUFFICIENT. It answers "what is this
 * route's ceiling", never "is this route the writer" — the second question is
 * the repo's standing `name the caller` rule and needs `pg_proc`, `pg_views`,
 * `cron.job.command`, the edge fleet and a repo grep, not a regex over one file.
 */
export const MAP_IS_WRONG_ABOVE = 1.2

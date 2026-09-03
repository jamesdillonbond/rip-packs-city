// lib/pipeline/kill-rate.ts
//
// Classify a heartbeated `after()` route's kill record.
//
// ── WHY THIS EXISTS (2026-08-28, written the same night it was needed) ─────
// `lib/pipeline/heartbeat.ts` explains how a killed `after()` route is read:
// by correlating a heartbeat row against a terminal row. That correlation is
// the ONLY instrument on this platform that can see such a kill — and it lived
// nowhere, so it was re-derived ad hoc every time it was wanted.
//
// It got re-derived wrong. A sweep on 2026-08-28 produced this table:
//
//   pipeline                    heartbeats  killed     %
//   candy-listings-indexer              25      14   56.0
//
// and that 56 % was filed as "still killed on 56 % of ticks after the 08-26
// fix — its own investigation". ⛔ WRONG. The kills are a CONTIGUOUS BLOCK
// that ENDED. Splitting the same rows at the deploy that landed 08-27 03:48Z:
//
//   PRE-fix    16 ticks   14 killed   87.5 %   avg  322 s   (of a 300 s wall)
//   POST-fix    9 ticks    0 killed    0.0 %   avg 28.5 s
//
// The fix worked — 11x faster, zero kills, holding at the peak hour. The
// pooled rate was measuring the fix's ABSENCE and reading as its FAILURE,
// because it averaged a broken era together with a healthy one.
//
// ⭐ THE LESSON, which is what this module encodes: A KILL RATE WITHOUT A
// RECENCY DISCRIMINATOR CANNOT TELL "BROKEN NOW" FROM "WAS BROKEN, FIXED, AND
// THE POOLED RATE STILL CARRIES THE CORPSE." Two of the six flagged pipelines
// flipped verdict once recency was added. `count` and `%` are not enough, and
// the fix date was sitting in the filing that pooled across it.
//
// So `classifyKillRecord` does not accept a rate. It requires the tick
// sequence, and it derives recency from that sequence — there is no way to
// call it with the two columns that misled.
//
// ── THE DISCRIMINATOR IS A TEST, NOT A THRESHOLD ──────────────────────────
// "How many clean ticks mean recovered?" has no good constant answer: 9 clean
// ticks is strong for a pipeline that was failing 87 % of the time and weak
// for one that was failing 20 %. So instead we ask the falsifiable question:
//
//   If NOTHING changed, how likely is this run of consecutive successes?
//
// p = (1 - killRate) ^ cleanTicks, under the null that ticks are independent
// at the pooled historical rate. Small p => the record changed => `recovered`.
//
// ⚠ The pooled rate is used deliberately, and it is the CONSERVATIVE choice:
// pooling the healthy era in DEFLATES the null kill rate (56 % rather than the
// broken era's 87.5 %), which RAISES p and makes `recovered` HARDER to reach.
// The test can therefore under-call a recovery; it will not manufacture one.
//
// 🚨 WHAT `killed` ACTUALLY MEANS, AND THE CASE THAT NARROWS IT (2026-09-03).
// `killed` is "no terminal row correlated to this marker" — which is NOT the
// same as "the platform did not kill this invocation". Measured, one tick:
// `cron/evm-transfers-ingest` at 2026-09-03 07:34:26Z carries a Vercel
// `Task timed out after 60 seconds` AND a marker AND a terminal row with
// ok = true and duration_ms = 60,464 against a 60,000 ms wall. ⭐ The terminal
// write raced the wall and won, so this classifier scores that tick CLEAN.
//
// ⚠ So a `healthy` verdict is a statement about terminal rows landing, not about
// invocations surviving, and the under-count is silent. The discriminator that
// would catch it is `duration_ms` at or beyond the ROUTE'S OWN `maxDuration` —
// deliberately not added here, because this module has no per-route wall to
// compare against (they live in `export const maxDuration` in each route file)
// and inventing a fleet-wide constant would misclassify every short-wall route.
// Wiring it needs the walls read from source; that is a real piece of work and
// it is named rather than half-done.
//
// ⚠ WHAT THIS DOES NOT DO. It is a description of a record, not a diagnosis.
// `recovered` means the kills stopped, never that anyone knows why — attribute
// a cause by naming the deploy, as the header above does. And independence is
// an assumption: kills cluster by hour and by deploy, so p is indicative, not
// a real significance level. It is a discriminator, not a proof.

/** One tick of a heartbeated route, oldest-first or newest-first — either is fine. */
export type KillTick = {
  /** When the heartbeat row was written. */
  startedAt: Date
  /** True when no terminal row correlated to this heartbeat: the `after()` body was killed. */
  killed: boolean
}

export type KillVerdict =
  /** No kill has ever been recorded in the window. */
  | 'healthy'
  /** The most recent tick was killed. Failing right now, whatever the rate. */
  | 'failing'
  /** Kills stopped, and the clean run is too long to be chance at the historical rate. */
  | 'recovered'
  /** Kills are present and the record does not separate — genuinely intermittent, or too few ticks to tell. */
  | 'intermittent'

export type KillRecord = {
  pipeline: string
  ticks: number
  killed: number
  /** Pooled over the whole window. ⚠ Never interpret without `verdict`. */
  killRatePct: number
  /** Consecutive most-recent ticks with no kill. */
  cleanTicks: number
  lastKillAt: Date | null
  lastOkAt: Date | null
  verdict: KillVerdict
  /**
   * P(this clean run | nothing changed), at the pooled rate. `null` when there
   * is no clean run, or when there are no kills to form a null rate from.
   */
  chanceRunIsLuck: number | null
  /** One line naming the evidence, safe to print verbatim. */
  note: string
}

/** A clean run this unlikely under the null is treated as a real change. */
export const RECOVERY_P_THRESHOLD = 0.05

/**
 * Classify one pipeline's tick sequence.
 *
 * ⚠ Pass EVERY tick in the window, not a filtered subset: the clean run is
 * counted from the end of the sequence, so a filtered tail invents a recovery.
 */
export function classifyKillRecord(pipeline: string, ticks: readonly KillTick[]): KillRecord {
  const ordered = [...ticks].sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime())
  const total = ordered.length
  const killed = ordered.filter((t) => t.killed).length

  if (total === 0) {
    // ⚠ Not `healthy`. No ticks is an absence of evidence — a route that never
    // ran looks identical to one that never failed, and calling that healthy is
    // the "failed read renders as an answer" defect in instrument form.
    return {
      pipeline,
      ticks: 0,
      killed: 0,
      killRatePct: 0,
      cleanTicks: 0,
      lastKillAt: null,
      lastOkAt: null,
      verdict: 'intermittent',
      chanceRunIsLuck: null,
      note: 'no heartbeats in the window — nothing is known about this pipeline, not even that it is idle',
    }
  }

  const killRate = killed / total
  const killRatePct = Math.round(killRate * 1000) / 10
  const lastKillAt = ordered.filter((t) => t.killed).at(-1)?.startedAt ?? null
  const lastOkAt = ordered.filter((t) => !t.killed).at(-1)?.startedAt ?? null

  let cleanTicks = 0
  for (let i = ordered.length - 1; i >= 0 && !ordered[i].killed; i--) cleanTicks++

  if (killed === 0) {
    return {
      pipeline,
      ticks: total,
      killed: 0,
      killRatePct: 0,
      cleanTicks,
      lastKillAt,
      lastOkAt,
      verdict: 'healthy',
      chanceRunIsLuck: null,
      note: `${total} ticks, no kills`,
    }
  }

  if (cleanTicks === 0) {
    return {
      pipeline,
      ticks: total,
      killed,
      killRatePct,
      cleanTicks: 0,
      lastKillAt,
      lastOkAt,
      verdict: 'failing',
      chanceRunIsLuck: null,
      note: `the most recent tick was KILLED (${killed}/${total} = ${killRatePct}% over the window)`,
    }
  }

  const chanceRunIsLuck = Math.pow(1 - killRate, cleanTicks)
  const recovered = chanceRunIsLuck < RECOVERY_P_THRESHOLD

  return {
    pipeline,
    ticks: total,
    killed,
    killRatePct,
    cleanTicks,
    lastKillAt,
    lastOkAt,
    verdict: recovered ? 'recovered' : 'intermittent',
    chanceRunIsLuck,
    note: recovered
      ? `kills STOPPED — ${cleanTicks} clean ticks after ${killed}/${total} killed; p=${chanceRunIsLuck.toExponential(1)} that this run is luck. ` +
        `⚠ the ${killRatePct}% pooled rate is HISTORICAL — do not report it as current`
      : `${killed}/${total} = ${killRatePct}% killed, ${cleanTicks} clean since; p=${chanceRunIsLuck.toFixed(2)} that the run is luck — NOT enough to call it recovered`,
  }
}

/** A `pipeline_runs` row, reduced to the two fields the correlation needs. */
export type PipelineRunRow = { pipeline: string; started_at: string }

/**
 * The suffix `lib/pipeline/heartbeat.ts` appends to form a marker row's name.
 * ⚠ Changing it here does not change the writer — this must track that module.
 */
export const HEARTBEAT_SUFFIX = '-heartbeat'

/**
 * ⚠ THE SECOND MARKER CONVENTION, and why this is not scope creep.
 *
 * `app/api/wallet-backfill-multicollection` predates `lib/pipeline/heartbeat.ts`
 * and hand-rolled the same idea under different names: a `-dispatch` row written
 * as the first statement of `after()`, and a `-complete` row written at the end.
 * That is exactly the heartbeat correlation, and the route's own comment says so:
 * *"dispatch row with no matching complete row within ~15min = killed lambda —
 * that's the visibility we want."*
 *
 * 🚨 Keying only on `-heartbeat` made this instrument SILENT about the fleet's
 * highest-volume killed pipeline — 2,339 dispatches, 41.5% with no complete,
 * measured 2026-08-28 within an hour of shipping the `-heartbeat`-only version.
 * An instrument that looks like it covers the fleet and quietly omits its worst
 * case is the defect class this module exists for, so it is fixed rather than
 * documented as a limitation.
 *
 * ⚠ THE DISCRIMINATOR IS STRUCTURAL, NOT A NAME ALLOWLIST. `alerts-dispatch` is
 * a REAL PIPELINE whose name merely ends in `-dispatch`; treating the suffix as
 * proof of a marker would invent a 100%-killed pipeline out of a healthy one. A
 * `-dispatch` name is a marker only when a `-complete` sibling actually exists in
 * the same data. That property is asserted in the tests with `alerts-dispatch`
 * itself as the negative control.
 *
 * ⚠ THE PRICE OF THAT RULE, pinned in the tests rather than left to be
 * rediscovered: with no `-complete` row anywhere in the window there is nothing
 * to prove the `-dispatch` is a marker, so a dispatch pipeline killed on EVERY
 * tick drops out of the report instead of reading 100%. It needs ~73 unbroken
 * hours of kills to happen, and the script's header already states that absence
 * from the report carries no information — but it is the worst case going quiet,
 * so it is written down. The fix, if it ever fires, is to derive marker names
 * from the route sources; it is NOT to add a list of names.
 */
export const DISPATCH_SUFFIX = '-dispatch'
export const COMPLETE_SUFFIX = '-complete'

/**
 * A terminal row counts as the same invocation as a heartbeat within this window.
 * The heartbeat is the first statement of the `after()` body and the terminal row
 * the last, so they share a start timestamp to within write latency. 5 s is
 * generous and still far below the tightest cadence in use (2 min).
 */
export const CORRELATION_WINDOW_MS = 5_000

/**
 * Turn raw `pipeline_runs` rows into one classified record per heartbeated pipeline.
 *
 * ⚠ Pass the FULL window. This is the step that was re-derived by hand and got
 * it wrong; the classifier's recency test is only as good as the sequence it is
 * handed, and a truncated input fabricates a clean run.
 *
 * ⚠ Pipelines with NO heartbeat row are absent from the result, and that absence
 * carries no information: un-heartbeated, idle, and never-firing all look the
 * same here. Do not read a short list as a clean bill of health.
 */
export function correlateRuns(rows: readonly PipelineRunRow[]): KillRecord[] {
  const heartbeats = new Map<string, Date[]>()
  const terminals = new Map<string, number[]>()

  // A `-dispatch` name is only a marker when its `-complete` sibling exists.
  // Derived from the data, never from a list of names — see DISPATCH_SUFFIX.
  const completeBases = new Set<string>()
  for (const r of rows) {
    if (r.pipeline.endsWith(COMPLETE_SUFFIX)) {
      completeBases.add(r.pipeline.slice(0, -COMPLETE_SUFFIX.length))
    }
  }

  const push = (m: Map<string, Date[]>, k: string, v: Date) => {
    const list = m.get(k)
    if (list) list.push(v)
    else m.set(k, [v])
  }
  const pushMs = (m: Map<string, number[]>, k: string, v: number) => {
    const list = m.get(k)
    if (list) list.push(v)
    else m.set(k, [v])
  }

  for (const r of rows) {
    const at = new Date(r.started_at)
    if (r.pipeline.endsWith(HEARTBEAT_SUFFIX)) {
      push(heartbeats, r.pipeline.slice(0, -HEARTBEAT_SUFFIX.length), at)
      continue
    }
    if (r.pipeline.endsWith(DISPATCH_SUFFIX)) {
      const base = r.pipeline.slice(0, -DISPATCH_SUFFIX.length)
      // `alerts-dispatch` lands here and has no `-complete` sibling, so it falls
      // through to be treated as an ordinary terminal row, which is what it is.
      if (completeBases.has(base)) {
        push(heartbeats, base, at)
        continue
      }
    }
    if (r.pipeline.endsWith(COMPLETE_SUFFIX)) {
      const base = r.pipeline.slice(0, -COMPLETE_SUFFIX.length)
      pushMs(terminals, base, at.getTime())
      continue
    }
    pushMs(terminals, r.pipeline, at.getTime())
  }

  const rank: Record<KillVerdict, number> = {
    failing: 0,
    intermittent: 1,
    recovered: 2,
    healthy: 3,
  }

  return [...heartbeats.entries()]
    .map(([pipeline, beats]) => {
      const term = terminals.get(pipeline) ?? []
      const ticks = beats.map((startedAt) => ({
        startedAt,
        killed: !term.some((t) => Math.abs(t - startedAt.getTime()) < CORRELATION_WINDOW_MS),
      }))
      return classifyKillRecord(pipeline, ticks)
    })
    .sort((a, b) => rank[a.verdict] - rank[b.verdict] || b.killRatePct - a.killRatePct)
}

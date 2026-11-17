// lib/http/sweep-deadline.ts
//
// One shared way to bound a `fetch()` that runs inside a sweep with a deadline.
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
// `fetch()` has NO default timeout. In an ordinary request handler an upstream
// that accepts the connection and then holds it open is merely slow. In an
// `after()` route with a `maxDuration` it is INVISIBLE:
//
//   the lambda is killed at maxDuration -> neither the success path nor the
//   catch runs -> NO terminal `pipeline_runs` row is written at all
//
// so the outage is indistinguishable from "the cron never fired". Measured on
// /api/candy-listings-indexer 2026-08-27: 15 invocation heartbeats against ONE
// terminal row in 48h, while the PUBLIC /insights/candy-mlb board served asks
// 44 hours stale. Triage of the whole class:
// docs/overnight/inbox/2026-08-27T0320Z-unbounded-fetch-is-a-class-29-sites-...
//
// ⭐ THE REASON IT IS A SHARED MODULE AND NOT ANOTHER INLINE CONSTANT. The fix
// for that outage already existed one file away — `solUsd()` in
// lib/chains/solana/das.ts carries an 8s cap and a comment naming this exact
// failure mode — and had never spread. CLAUDE.md says "when you find one, grep
// for the EXPRESSION, not the file"; this is that rule in the direction nobody
// checks. **It was not the DEFECT that spread by copy-paste, it was the FIX
// that failed to.** A comment is only read by someone already in that file, so
// the reasoning is put somewhere importable instead.
//
// ── WHY A DERIVED BOUND AND NOT A CHOSEN ONE ────────────────────────────────
// The triage filing warns that the correct timeout is NOT a constant, and that
// "a short cap converts working behaviour into failure". That is a real risk
// whenever the cap is a guess about the upstream.
//
// ⭐ So this helper does not guess. It derives the bound from a budget the
// CALLER ALREADY DECLARES — the sweep deadline it is already checking between
// iterations. A request that would outlive the remaining sweep budget is
// already doomed: the loop would have stopped on its next check anyway, and the
// only question is whether the route gets to write its terminal row first.
// Aborting it therefore cannot convert a working call into a failing one; it
// can only convert a SILENT kill into a LOGGED failure.
//
// ⚠ This is deliberately NOT an upstream SLA. If a caller wants a tighter,
// upstream-specific cap (as the Magic Eden and DAS callers do, at 8-15s), it
// should pass `maxMs` — the two bounds compose, and the tighter one wins.
//
// ⚠ It is also NOT a substitute for the sweep deadline itself. Per-request caps
// alone still permit N x cap; the loop must still check its own budget. Both
// guarantees are needed, which is the subtlety the candy fix had to handle.

/** Floor for a derived bound. Below this an abort is certain and pointless. */
const MIN_TIMEOUT_MS = 1_000;

export interface SweepDeadlineOptions {
  /**
   * Milliseconds to hold back from the budget for the phases that must still
   * run after the walk (writes, drain, and above all the terminal log). Without
   * a reserve the last request can consume the entire budget and the route is
   * killed before it records anything — the exact failure being fixed.
   */
  reserveMs?: number;
  /** Optional upstream-specific ceiling. The tighter of the two bounds wins. */
  maxMs?: number;
}

/**
 * Milliseconds a request may still run without pushing the sweep past its
 * budget. Clamped to at least {@link MIN_TIMEOUT_MS}.
 */
export function remainingBudgetMs(
  startedMs: number,
  budgetMs: number,
  options: SweepDeadlineOptions = {}
): number {
  const { reserveMs = 0, maxMs } = options;
  const left = budgetMs - (Date.now() - startedMs) - reserveMs;
  const capped = maxMs == null ? left : Math.min(left, maxMs);
  return Math.max(MIN_TIMEOUT_MS, capped);
}

/**
 * An `AbortSignal` for a single `fetch()` inside a sweep that started at
 * `startedMs` and must finish within `budgetMs`.
 *
 * Pass it as `signal:` in the request init:
 *
 *     const res = await fetch(url, {
 *       headers,
 *       signal: sweepDeadlineSignal(startedMs, HARD_BUDGET_MS, { reserveMs: 60_000 }),
 *     });
 *
 * ⚠ An abort surfaces as a thrown `TimeoutError`, NOT a non-ok response — so
 * the caller's existing catch/log path records it. That visibility is the point.
 */
export function sweepDeadlineSignal(
  startedMs: number,
  budgetMs: number,
  options: SweepDeadlineOptions = {}
): AbortSignal {
  return AbortSignal.timeout(remainingBudgetMs(startedMs, budgetMs, options));
}

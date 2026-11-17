// Rotate the sentinel arms that the wall budget starves, so the SAME ones are
// not the ones blinded every time.
//
// ── THE DEFECT, MEASURED 2026-09-19 ─────────────────────────────────────────
// The sentinel bounds itself with one wall budget (app/api/sentinel/route.ts):
// once it is spent, every remaining arm is REFUSED before its request leaves
// the process and reports INCONCLUSIVE. That rule is correct and earned — it
// replaced a 180 s Vercel kill that wrote nothing anywhere.
//
// What nothing accounted for is that arm order is FIXED, so refusal is not a
// lottery. Across the 83 sweeps then in `pipeline_runs` retention (09-16 12:04
// → 09-19 11:09 PT), refusals landed on a contiguous tail and nowhere else:
//
//   pg_net Dispatch    25 / 83  (30.1%)
//   Ops Probe Cost     25 / 83  (30.1%)
//   Wall Kills (24h)   20 / 83  (24.1%)
//   Cadence Collapse    6 / 83   (7.2%)
//   Zero-Yield Lanes    4 / 83   (4.8%)
//   Alert Delivery      4 / 83   (4.8%)
//   every arm above     0 / 83   (0%)
//
// ⭐ So `pg_net Dispatch` has a standing 30% duty-cycle hole, and the report
// never says so: `Measurement Blackout` states how MANY arms were blind on a
// given sweep, which is the population fact it was built for, and no instrument
// states that the blind set is the same set every time. An arm that cannot be
// evaluated on a third of sweeps is a third of the way to the repo's own rule —
// a permanently-red or -zero instrument is indistinguishable from a broken one.
//
// ⚠ ROTATION DOES NOT BUY BUDGET, AND IS NOT CLAIMED TO. The same number of
// arms are refused; what changes is WHICH. Over n consecutive sweeps each arm
// holds each position exactly once, so a 30%-blind arm becomes n arms blind
// ~30/n% each, and every arm has a recent real reading. Making the sweep
// actually cheaper is a separate question and is NOT addressed here.
//
// ── WHY `Ops Probe Cost` IS NOT IN THE ROTATION ─────────────────────────────
// ⛔ It is pinned last BY ITS OWN CONTRACT: it reads `pg_stat_statements` for
// every ops RPC, so it must run after the arms it measures or its row is a
// sweep stale. Rotating it would trade a measured blind spot for a silently
// wrong reading, which is the worse defect. It therefore KEEPS its ~30% refusal
// rate, and that is a known, stated cost of this fix rather than something the
// rotation quietly covers. The lever for it is a cheaper sweep or a dedicated
// reserve, neither of which is this change.

/**
 * How much wall-clock time one rotation step spans.
 *
 * ⚠ Derived from the sweep cadence, not chosen: the sentinel's scheduled sweep
 * is hourly, so an hour-wide step advances the offset by exactly one per
 * scheduled sweep and the rotation is a clean round-robin — each arm reaches
 * each position once per `arms.length` sweeps, for any arm count.
 *
 * ⚠ A step much SHORTER than the cadence is the trap: the offset then advances
 * by `sweepsPerStep` positions at a time, and whenever that stride shares a
 * factor with `arms.length` the rotation visits only a SUBSET of positions and
 * some arm stays starved forever — the very defect this module exists to fix,
 * reintroduced by a constant. The test pins round-robin coverage at the real
 * arm count so a future edit to either number has to face it.
 */
export const ROTATION_STEP_MS = 60 * 60 * 1000;

/**
 * Rotate `arms` by a step derived from when the sweep started.
 *
 * Returns a permutation of the input — same members, same length, never a copy
 * that drops or duplicates one. Deterministic: the same sweep start always
 * yields the same order, so a report can be reproduced from its own timestamp.
 *
 * @param arms        the starvable arms, in their canonical declaration order
 * @param sweepStartMs epoch ms of this sweep's start
 */
export function rotateStarvedTail<T>(arms: readonly T[], sweepStartMs: number): T[] {
  const n = arms.length;
  if (n <= 1) return [...arms];
  // A non-finite or negative clock must not produce a NaN index and silently
  // return an empty order — it falls back to the declared order instead.
  if (!Number.isFinite(sweepStartMs) || sweepStartMs < 0) return [...arms];
  const offset = Math.floor(sweepStartMs / ROTATION_STEP_MS) % n;
  return [...arms.slice(offset), ...arms.slice(0, offset)];
}

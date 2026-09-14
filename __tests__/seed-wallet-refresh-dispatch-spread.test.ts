// The wallet-backfill dispatch SPREAD — pinned at the value it ACTUALLY has, which
// is not the value the route's header comment promises.
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
// `app/api/seed-wallet-refresh/route.ts` carries an incident-driven load-shed
// (2026-06-10): ~252 orchestrators, each fanning to 5 collection children, all
// dispatched within ~30s put ~1,260 child lambdas on the pool at once. allday and
// pinnacle threw 210/203 failures in 5 min, and child `elapsed_ms` went
// UNCORRELATED with wallet size (a 16-moment wallet logged 838s, a 5,208-moment
// wallet 604s) — the signature of pool saturation rather than work.
//
// The fix spreads dispatch starts over ~9 minutes, and the header comment has
// claimed that ever since. Measured 2026-09-13 (PT) it is FALSE: four cohort waves
// spread 28/23/29/31 orchestrators over 1.4/1.0/1.4/1.7 minutes. Nothing went red,
// because nothing asserted it — no test referenced any pacing constant.
//
// ⛔ THE CAUSE IS WHY THIS FILE ASSERTS A SPREAD AND NEVER A CONSTANT. The cohort
// split (`of: 4`) cut each invocation to ~28 tasks → 6 batches → 5 gaps → a computed
// pause of 108s, which the 20s MAX_PAUSE_MS clamps. Five 20s pauses is the ~100s
// observed. A change that REDUCED per-run load silently destroyed the pacing that
// WAS the load-shed — without touching one line of pacing code. A test pinning the
// constants would have stayed green straight through that regression.
//
// 🚨 READ THIS BEFORE "FIXING" A FAILURE HERE. These bounds encode the BROKEN
// spread ON PURPOSE. The repair is known and verified (MAX_PAUSE_MS → 120_000,
// which yields 6–9 min across the observed range) but is BLOCKED ON VERCEL SPEND:
// it raises this route's wall time ~1.7 min → ~9 min at 28 invocations/day
// ≈ 3.4 extra lambda-hours/day, and a Vercel spend-cap pause took the site down
// for ~10h on 2026-09-10 with the cap raised only slightly after. That is Trevor's
// call. If you are making it, flip MAX_PAUSE_MS and the two bounds marked BLOCKED.
import { describe, it, expect } from "vitest"
import { dispatchPlan } from "@/app/api/seed-wallet-refresh/route"

/** Cohort sizes actually observed in production on 2026-09-13 (PT). */
const OBSERVED_COHORT_SIZES = [23, 28, 29, 31]

describe("wallet-backfill dispatch spread", () => {
  it("BLOCKED: records the spread the code actually produces, not the 9 min promised", () => {
    // 2026-09-13 production: 31 dispatches over ~1.7 min. 5 gaps x 20s = 100_000ms.
    // This EXACT number was reproduced by the plan arithmetic before it was pinned,
    // which is what confirmed the mechanism rather than a correlation.
    expect(dispatchPlan(31).spreadMs).toBe(100_000)
    expect(dispatchPlan(23).spreadMs).toBe(60_000)
  })

  it("BLOCKED: every observed cohort falls far short of TARGET_SPREAD_MS", () => {
    // The gap between promise and behaviour, stated as an assertion so it cannot
    // quietly stop being true in either direction.
    for (const n of OBSERVED_COHORT_SIZES) {
      const plan = dispatchPlan(n)
      expect(plan.spreadMs, `cohort ${n}`).toBeLessThan(9 * 60 * 1000)
      expect(plan.pauseMs, `cohort ${n} is clamped, not computed`).toBe(20_000)
    }
  })

  it("the clamp — not the target — is what binds at real cohort sizes", () => {
    // Reaching a 9-min spread at a 20s clamp needs >= 27 gaps, i.e. >= 163 tasks in
    // ONE invocation. Cohorts run 23-31, so the target is unreachable by arithmetic
    // and not by accident. THIS is the property that must survive any repair.
    expect(dispatchPlan(163).pauseMs).toBe(20_000)
    expect(dispatchPlan(163).spreadMs).toBe(540_000)
    for (const n of OBSERVED_COHORT_SIZES) {
      expect(dispatchPlan(n).batches - 1, `cohort ${n} gap count`).toBeLessThan(27)
    }
  })

  it("never lets the spread outrun the lambda budget, at any cohort size", () => {
    // MAX_RUN_MS (720s) fires the tail unpaced past its threshold, and maxDuration
    // is 800s. This must hold before AND after the repair — it is the bound that
    // makes raising MAX_PAUSE_MS safe rather than reckless.
    for (const n of [1, 6, 7, ...OBSERVED_COHORT_SIZES, 60, 163, 400, 2000]) {
      expect(dispatchPlan(n).spreadMs, `cohort ${n}`).toBeLessThanOrEqual(720_000)
    }
  })

  it("charges no pause when there is nothing to pace", () => {
    expect(dispatchPlan(1).spreadMs).toBe(0)
    expect(dispatchPlan(6).spreadMs).toBe(0)
    expect(dispatchPlan(0).spreadMs).toBe(0)
  })
})

// The sentinel's wall-budget clock, scoped to ONE invocation.
//
// ── THE DEFECT ───────────────────────────────────────────────────────────────
// The wall budget (`wall-budget.ts`) shipped 2026-09-13 with its clock as
// module state in `app/api/sentinel/route.ts`: `runSentinel` set it at its
// start, flipped it to "terminal" after the last arm and cleared it at the end,
// on the stated premise that "sentinel invocations never overlap". That premise
// held for exactly as long as the sentinel had one caller. The same afternoon a
// second caller went live (cron-job.org `4 * * * *`, the redundant lane for
// GitHub's shed ticks, register #79/#80) and the two overlapped for 50.8 s at
// 2:02–2:04 PM PT — GitHub's delayed `34` tick and cron-job.org's `4` tick in one
// window, which is the EXPECTED case with a ~45-minute median delay.
//
// With a shared clock, two sweeps on one warm instance would have:
//   • the second sweep's start OVERWRITING the first's, so the first computes
//     its remaining budget from a later start and runs INTO its own wall — the
//     kill the budget exists to prevent;
//   • the first sweep's end setting the clock to null, so the second's remaining
//     reads fall back to the bare per-query cap and its terminal phase is never
//     entered — the budget silently OFF for the sweep that needed it.
// Neither broke that day (both sweeps finished with margin). The INVARIANT broke.
//
// ── THE SHAPE ────────────────────────────────────────────────────────────────
// AsyncLocalStorage: the clock lives in the async context of the invocation
// that started it, so every read the sweep issues — however deep, however many
// awaits later — sees ITS OWN clock, and a concurrent sweep sees its own. Nothing
// is set or cleared; the scope ends when `withSentinelClock`'s promise settles.
// Outside any sweep the getter returns null and the fetch wrapper applies the
// per-query cap only, exactly as before.
import { AsyncLocalStorage } from "node:async_hooks";
import type { WallBudgetClock } from "./wall-budget";

const store = new AsyncLocalStorage<WallBudgetClock>();

/** The clock of the sweep this code is running inside, or null outside one. */
export function currentSentinelClock(): WallBudgetClock | null {
  return store.getStore() ?? null;
}

/** Run one sweep with its own clock; the scope ends when `fn` settles. */
export function withSentinelClock<T>(
  clock: WallBudgetClock,
  fn: (clock: WallBudgetClock) => Promise<T>,
): Promise<T> {
  return store.run(clock, () => fn(clock));
}

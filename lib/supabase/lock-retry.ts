// lib/supabase/lock-retry.ts
//
// Bounded retry for a PostgREST write that lost a ROW-LOCK race: a lock timeout
// (55P03) or a deadlock (40P01). Nothing else is retried.
//
// WHY IT EXISTS (2026-11-11). `candy-editions-ingest` failed its 01:10 UTC tick
// two days running on ONE rejected `wallet_moments_cache` chunk ("canceling
// statement due to lock timeout"), then succeeded at 04:10. Postgres logs show
// both cancels at ~01:13:24 UTC, each one a PostgREST session waiting on a
// Candy row held by another PostgREST session. The holder lined up to the second
// on both days with the `wmc-fmv-populate` route's Candy step (it runs every 5 minutes), which held
// Candy wmc rows for 19 s (11-10, 01:13:22–:41) and 42 s (11-11, 01:13:16–:58).
// That step runs every 5 minutes, so a 5–6 min walk overlaps it whatever its
// start minute; moving the cron cannot avoid it. (The step's lock itself was
// fixed the same day: audit_20261111_populate_wmc_fmv_locks_only_fillable_rows.)
// The holder lets go within a minute, so the fix is to wait it out.
//
// A lock wait is bounded by the `authenticator` role's lock_timeout (8 s on
// 2026-11-11), so each failed attempt costs ~8 s plus the backoff. The defaults
// below wait 5 s + 15 s + 30 s between four attempts, which covers a holder of
// ~75 s (the longest run seen on 11-10 was 67 s). A RUN-LEVEL budget caps the total
// extra sleep so a lock storm cannot push a long walk into its maxDuration kill.
//
// ⛔ 57014 (statement timeout) is NOT retried. A statement that ran out of time
// will run out again, and retrying it only adds load (see rpc-with-retry.ts).

export interface WriteResult<T> {
  data: T | null
  error: { message?: string; code?: string } | null
}

export interface LockRetryBudget {
  /** extra sleep (ms) this run may still spend on lock retries */
  msLeft: number
  /** writes that hit a lock error and then succeeded on a retry */
  recovered: number
  /** retries actually scheduled (attempts after the first) */
  retries: number
}

export const LOCK_RETRY_DELAYS_MS = [5_000, 15_000, 30_000] as const
export const LOCK_RETRY_RUN_BUDGET_MS = 120_000

export function newLockRetryBudget(ms: number = LOCK_RETRY_RUN_BUDGET_MS): LockRetryBudget {
  return { msLeft: ms, recovered: 0, retries: 0 }
}

/** True only for row-lock contention: lock timeout (55P03) or deadlock (40P01). */
export function isLockContention(err: { message?: string; code?: string } | null | undefined): boolean {
  if (!err) return false
  if (err.code === "55P03" || err.code === "40P01") return true
  const msg = String(err.message ?? "").toLowerCase()
  return msg.includes("due to lock timeout") || msg.includes("deadlock detected")
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/**
 * Run `op`. If it fails on lock contention, wait and try again, up to
 * `delays.length` more times while the run budget lasts. Any other error is
 * returned at once. The result is the last attempt's, so a write that never
 * landed still comes back with its error.
 */
export async function withLockRetry<T>(
  op: () => PromiseLike<WriteResult<T>>,
  budget: LockRetryBudget,
  opts: { delays?: readonly number[]; sleep?: (ms: number) => Promise<void> } = {},
): Promise<WriteResult<T>> {
  const delays = opts.delays ?? LOCK_RETRY_DELAYS_MS
  const sleep = opts.sleep ?? realSleep
  let res = await op()
  let retried = false
  for (const delay of delays) {
    if (!isLockContention(res.error)) break
    if (budget.msLeft < delay) break
    budget.msLeft -= delay
    budget.retries++
    retried = true
    await sleep(delay)
    res = await op()
  }
  if (retried && !res.error) budget.recovered++
  return res
}

// lib/wallet-backfill-lock.ts
//
// Concurrency guard for the wallet-backfill / snapshot writer families.
// Wraps the claim_pipeline_lock / release_pipeline_lock RPCs
// (audit_20260627_pipeline_run_locks_concurrency_guard) so a concurrent
// invocation of the same per-wallet-per-collection walk is a NO-OP.
//
// Why this exists: the wallet-backfill children are ALREADY row-idempotent
// (upsert_wmc_batch ON CONFLICT), so double-firing won't dup rows. The real
// cost of overlap is 2x expensive on-chain Cadence calls per wallet + the
// Supabase connection-pool / IO saturation documented in the 2026-06-10 DBSAT
// incident. With this guard, overlap is harmless — which is what lets the
// redundant GitHub Actions backstop be added WITHOUT an atomic cron-job.org
// cutover.
//
// FAIL-OPEN by design: a lock-table error must NEVER become a new single
// point of failure that silently halts ingest. On any RPC error/throw,
// claim returns true (proceed) — the same philosophy as the sentinel
// threshold-config fallback. The worst case of a fail-open is the pre-guard
// behavior (a possible double walk), which is strictly better than dropping
// the walk entirely.

import { supabaseAdmin } from "@/lib/supabase"

// Per-(collection, wallet) key so different collections for the SAME wallet
// never block each other — the multicollection orchestrator fires all 5
// children for one wallet at once and they must run in parallel.
export function walletBackfillLockKey(collectionSlug: string, wallet: string): string {
  return `wallet-backfill:${collectionSlug}:${wallet.toLowerCase()}`
}

// Returns true if the caller acquired the lock (should proceed), false if a
// fresh in-progress claim is already held by a concurrent invocation (should
// no-op). Fail-open: returns true on any error.
export async function claimPipelineLock(
  lockKey: string,
  staleSeconds?: number,
): Promise<boolean> {
  try {
    const args: Record<string, unknown> = { p_key: lockKey }
    if (typeof staleSeconds === "number") args.p_stale_seconds = staleSeconds
    const { data, error } = await (supabaseAdmin as any).rpc("claim_pipeline_lock", args)
    if (error) {
      console.warn(`[pipeline-lock] claim error key=${lockKey}: ${error.message} — proceeding (fail-open)`)
      return true
    }
    return data === true
  } catch (err) {
    console.warn(
      `[pipeline-lock] claim threw key=${lockKey}: ${err instanceof Error ? err.message : String(err)} — proceeding (fail-open)`,
    )
    return true
  }
}

export async function releasePipelineLock(lockKey: string): Promise<void> {
  try {
    await (supabaseAdmin as any).rpc("release_pipeline_lock", { p_key: lockKey })
  } catch (err) {
    console.warn(
      `[pipeline-lock] release threw key=${lockKey}: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

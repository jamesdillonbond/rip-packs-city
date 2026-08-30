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
// FAIL-OPEN by design — with ONE carved-out class (2026-08-30). A lock-table
// error must NEVER become a new single point of failure that silently halts
// ingest: on an RPC error/throw that says the LOCK TABLE is broken (missing
// function, permission, schema drift…), claim returns true (proceed). The
// worst case of that fail-open is the pre-guard behavior (a possible double
// walk), which is strictly better than dropping the walk entirely.
//
// The carve-out: when the claim fails because the DATABASE HAS NO CAPACITY —
// "Timed out acquiring connection from connection pool", PostgREST's "Could
// not query the database for the schema cache", a lock/statement timeout —
// the premise of the fail-open inverts. Measured 2026-08-29/30 (24 h): 656
// claim errors of exactly these three shapes, every one proceeding, and 226
// overlapping same-wallet walks (103 wallets, >=56k duplicated worker-seconds)
// on the very table the pool was saturated writing to. A double walk is then
// the WORST outcome, not the cheapest: it is more load on the thing that just
// said it had none, and the wallet is re-dispatched on the next cohort cycle
// anyway. So that class fails CLOSED (skip this tick) and is reported under
// its own terminated_reason so a skipped tick is never mistaken for a lock
// held by a live sibling.

import { supabaseAdmin } from "@/lib/supabase"

// Per-(collection, wallet) key so different collections for the SAME wallet
// never block each other — the multicollection orchestrator fires all 5
// children for one wallet at once and they must run in parallel.
export function walletBackfillLockKey(collectionSlug: string, wallet: string): string {
  return `wallet-backfill:${collectionSlug}:${wallet.toLowerCase()}`
}

export type PipelineLockClaim =
  | { claimed: true; reason: "claimed" | "fail_open" }
  | { claimed: false; reason: "in_progress" | "db_saturated" }

// Error shapes that mean "the database has no capacity right now", as they
// reach a supabase-js caller through PostgREST / Supavisor. Anything NOT in
// this list keeps the original fail-open (lock table broken -> proceed).
const DB_SATURATION_SIGNATURES: readonly RegExp[] = [
  /timed out acquiring connection from connection pool/i,
  /could not query the database for the schema cache/i,
  /canceling statement due to (lock|statement) timeout/i,
  /connection pool timeout/i,
]

export function isDbSaturationError(message: string): boolean {
  return DB_SATURATION_SIGNATURES.some((re) => re.test(message))
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// Detailed form: says WHY the caller should or should not proceed, so the
// runner can record the true reason in pipeline_runs.extra.terminated_reason.
export async function claimPipelineLockDetailed(
  lockKey: string,
  staleSeconds?: number,
): Promise<PipelineLockClaim> {
  try {
    const args: Record<string, unknown> = { p_key: lockKey }
    if (typeof staleSeconds === "number") args.p_stale_seconds = staleSeconds
    const { data, error } = await (supabaseAdmin as any).rpc("claim_pipeline_lock", args)
    if (error) {
      if (isDbSaturationError(String(error.message ?? ""))) {
        console.warn(
          `[pipeline-lock] claim error key=${lockKey}: ${error.message} — database saturated, skipping this tick (fail-closed)`,
        )
        return { claimed: false, reason: "db_saturated" }
      }
      console.warn(`[pipeline-lock] claim error key=${lockKey}: ${error.message} — proceeding (fail-open)`)
      return { claimed: true, reason: "fail_open" }
    }
    return data === true ? { claimed: true, reason: "claimed" } : { claimed: false, reason: "in_progress" }
  } catch (err) {
    const msg = errorMessage(err)
    if (isDbSaturationError(msg)) {
      console.warn(
        `[pipeline-lock] claim threw key=${lockKey}: ${msg} — database saturated, skipping this tick (fail-closed)`,
      )
      return { claimed: false, reason: "db_saturated" }
    }
    console.warn(`[pipeline-lock] claim threw key=${lockKey}: ${msg} — proceeding (fail-open)`)
    return { claimed: true, reason: "fail_open" }
  }
}

// Returns true if the caller acquired the lock (should proceed), false if a
// fresh in-progress claim is already held by a concurrent invocation OR the
// database reported it has no capacity for the walk (should no-op either way).
// Fail-open on every other error.
export async function claimPipelineLock(
  lockKey: string,
  staleSeconds?: number,
): Promise<boolean> {
  return (await claimPipelineLockDetailed(lockKey, staleSeconds)).claimed
}

// The pipeline_runs terminated_reason for a claim that said "do not proceed".
export function skippedReasonFor(claim: PipelineLockClaim): "skipped_in_progress" | "skipped_db_saturated" {
  return claim.reason === "db_saturated" ? "skipped_db_saturated" : "skipped_in_progress"
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

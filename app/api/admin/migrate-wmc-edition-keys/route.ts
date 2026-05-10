// app/api/admin/migrate-wmc-edition-keys/route.ts
//
// POST — drains wallet_moments_cache.edition_key from the legacy integer
// "set:play" format to the canonical UUID-edition external_id by
// repeatedly calling SECDEF RPC public.wmc_edition_key_drain_v3(p_limit).
//
// 2026-05-09 (R9): switched from v2 to v3. v2 looked up via the
// editions_canonical_pair view, which silently returned zero rows after
// the int-format editions were deleted in earlier dedup phases — every
// invocation since was a no-op. v3 reaches through editions.external_id
// directly and migrated all 201,151 NBA TS orphans in 5s when manually
// run. Same intent, different lookup path.
//
// Return-shape difference: v2 was TABLE(pairs_claimed int, rows_updated
// bigint, pairs_remaining int); v3 returns jsonb with the same keys plus
// algo_version='drain-v3-external-id'. supabase-js surfaces the jsonb as
// the `data` field directly (no array wrapper), so the extraction below
// handles both shapes for safety.
//
// Auth: Bearer RPC_ADMIN_TOKEN (or ?token=) via verifyAdminRequest.
// Idempotent: re-running drains whatever's left.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { verifyAdminRequest, adminUnauthorizedResponse } from "@/lib/admin-auth";

export const maxDuration = 30;
export const dynamic = "force-dynamic";

const BATCH_SIZE = 5000;
// Capped under cron-job.org's 30s request timeout. Loop returns early when
// v3 reports pairs_claimed=0 AND pairs_remaining=0 (queue genuinely drained);
// otherwise the next cron tick resumes from wmc_dedup_pairs.processed=false.
const TIME_BUDGET_MS = 25_000;

export async function POST(req: NextRequest) {
  if (!verifyAdminRequest(req)) return adminUnauthorizedResponse();

  const startedAt = Date.now();
  let batchesProcessed = 0;
  let rowsUpdated = 0;
  let pairsSelfSynced = 0;
  let pairsRemaining: number | null = null;
  let drained = false;

  // Self-sync newly-paired editions (as the GraphQL hydrator catches up
  // with the orphan backlog) into wmc_dedup_pairs at the top of every
  // invocation so the drain loop picks them up without manual migrations.
  // Dedicated RPC because query_sql wraps its argument in `SELECT ... FROM
  // (<input>) t`, which Postgres rejects when <input> is a CTE containing a
  // data-modifying statement ("WITH clause containing a data-modifying
  // statement must be at the top level"). The RPC returns a scalar int.
  const { data: syncData, error: syncError } = await supabaseAdmin.rpc(
    "wmc_dedup_pairs_sync_from_view"
  );
  if (syncError) {
    console.warn(
      `[migrate-wmc-edition-keys] self-sync error: ${syncError.message}`
    );
    pairsSelfSynced = 0;
  } else {
    pairsSelfSynced = Number(syncData ?? 0);
  }

  let algoVersion: string | null = null;

  while (Date.now() - startedAt < TIME_BUDGET_MS) {
    const { data, error } = await supabaseAdmin.rpc(
      "wmc_edition_key_drain_v3",
      { p_limit: BATCH_SIZE }
    );

    if (error) {
      console.error(
        `[migrate-wmc-edition-keys] batch error: ${error.message} batches_processed=${batchesProcessed} rows_updated=${rowsUpdated}`
      );
      return NextResponse.json(
        {
          error: error.message,
          batches_processed: batchesProcessed,
          rows_updated: rowsUpdated,
          pairs_self_synced: pairsSelfSynced,
          pairs_remaining: pairsRemaining,
          duration_ms: Date.now() - startedAt,
        },
        { status: 500 }
      );
    }

    // v3 returns jsonb (object) with { pairs_claimed, rows_updated,
    // pairs_remaining, algo_version }. supabase-js surfaces a function-
    // returns-jsonb as the parsed object directly. Defensively support the
    // legacy v2 array-of-row shape too in case Supabase serializes it
    // differently in some edge case — first element of array, or object.
    const row = (Array.isArray(data) ? data[0] : data) as
      | { pairs_claimed?: number; rows_updated?: number | string; pairs_remaining?: number; algo_version?: string }
      | null;
    const pairsClaimed = Number(row?.pairs_claimed ?? 0);
    const rowsThisBatch = Number(row?.rows_updated ?? 0);
    pairsRemaining = Number(row?.pairs_remaining ?? 0);
    if (typeof row?.algo_version === "string") algoVersion = row.algo_version;

    rowsUpdated += rowsThisBatch;
    batchesProcessed += 1;

    // No concurrent drainers — single-iteration zero is genuine drain.
    if (pairsClaimed === 0 && pairsRemaining === 0) {
      drained = true;
      break;
    }
  }

  let wmcIntRemainingOrphans: number | null = null;
  try {
    const { data: cnt, error: cntErr } = await supabaseAdmin.rpc("query_sql", {
      query: `
        SELECT COUNT(*)::bigint AS cnt
        FROM wallet_moments_cache
        WHERE edition_key ~ '^[0-9]+:[0-9]+$'
      `,
    });
    if (!cntErr && Array.isArray(cnt) && cnt[0] && typeof cnt[0].cnt !== "undefined") {
      wmcIntRemainingOrphans = Number(cnt[0].cnt);
    }
  } catch (err) {
    console.warn(
      "[migrate-wmc-edition-keys] wmc_int_remaining_orphans count failed:",
      err instanceof Error ? err.message : err
    );
  }

  const durationMs = Date.now() - startedAt;
  const drainedOrTimedOut = drained ? "drained" : "timed_out";

  console.log(
    `[migrate-wmc-edition-keys] done batches=${batchesProcessed} updated=${rowsUpdated} pairs_self_synced=${pairsSelfSynced} pairs_remaining=${pairsRemaining} wmc_int_remaining_orphans=${wmcIntRemainingOrphans} status=${drainedOrTimedOut} duration_ms=${durationMs}`
  );

  // Single pipeline_runs row per invocation — unlocks pipeline_cadence_watchlist
  // monitoring on the cron schedule. Logging failure must never break the
  // route's response, so we swallow the error to console.warn.
  try {
    await (supabaseAdmin as any).rpc("log_pipeline_run", {
      p_pipeline: "migrate-wmc-edition-keys",
      p_started_at: new Date(startedAt).toISOString(),
      p_rows_found: pairsSelfSynced,
      p_rows_written: rowsUpdated,
      p_rows_skipped: pairsRemaining ?? 0,
      p_ok: drained,
      p_error: drained ? null : "budget exceeded",
      p_collection_slug: null,
      p_cursor_before: null,
      p_cursor_after: null,
      p_extra: {
        batches_processed: batchesProcessed,
        wmc_int_remaining_orphans: wmcIntRemainingOrphans,
        algo_version: algoVersion,
      },
    });
  } catch (err) {
    console.warn(
      `[migrate-wmc-edition-keys] log_pipeline_run err: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }

  return NextResponse.json({
    batches_processed: batchesProcessed,
    rows_updated: rowsUpdated,
    pairs_remaining: pairsRemaining,
    wmc_int_remaining_orphans: wmcIntRemainingOrphans,
    drained_or_timed_out: drainedOrTimedOut,
    duration_ms: durationMs,
    pairs_self_synced: pairsSelfSynced,
  });
}

// app/api/admin/migrate-wmc-edition-keys/route.ts
//
// POST — drains wallet_moments_cache.edition_key from the legacy integer
// "set:play" format to the canonical UUID-edition external_id by
// repeatedly calling SECDEF RPC public.wmc_edition_key_drain_v3(p_limit).
//
// 2026-05-12 (R10) fix: v3's actual return shape diverged from the keys
// this route was reading.
//
//   The 2026-05-09 commit message documented v3 as returning
//     { pairs_claimed, rows_updated, pairs_remaining, algo_version }
//   matching v2's TABLE shape. The function was later rewritten to return
//     { started_at, finished_at, rows_migrated, wmc_int_remaining_orphans,
//       algo_version }
//   without updating the route. Every loop iteration therefore parsed 0s
//   for "pairs_claimed" and "pairs_remaining", broke out of the loop on
//   the first pass, and reported drained=true with rows_updated=0 — even
//   while the RPC was silently migrating up to p_limit rows per call.
//
//   The pipeline_runs gap between 2026-05-11 23:37 UTC and 2026-05-12
//   04:37 UTC additionally correlated with a cluster of unrelated deploys
//   (Fast Break, FMV cold-tail, EVM scaffolding, moment-detail page) and
//   an INGEST_SECRET_TOKEN / RPC_ADMIN_TOKEN rotation. The 401s from
//   04:37 onward are explained by stale cron-job.org token config; that
//   side fixes itself when Trevor updates the cron token. This commit
//   fixes the route side.
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
// the RPC reports rows_migrated=0 (no remaining orphans match an editions
// row); otherwise the next cron tick resumes from wmc_dedup_pairs.processed
// = false.
const TIME_BUDGET_MS = 25_000;

type DrainV3Result = {
  rows_migrated?: number | string | null;
  wmc_int_remaining_orphans?: number | string | null;
  algo_version?: string | null;
  // Legacy v2-shape keys; retained so a future rollback of the RPC body
  // doesn't immediately re-break this route.
  pairs_claimed?: number | string | null;
  rows_updated?: number | string | null;
  pairs_remaining?: number | string | null;
};

function numFrom(...candidates: Array<unknown>): number {
  for (const c of candidates) {
    if (c == null) continue;
    const n = typeof c === "number" ? c : Number(c);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

export async function POST(req: NextRequest) {
  if (!verifyAdminRequest(req)) return adminUnauthorizedResponse();

  const startedAt = Date.now();
  let batchesProcessed = 0;
  let rowsUpdated = 0;
  let pairsSelfSynced = 0;
  let remainingOrphans: number | null = null;
  let drained = false;
  let algoVersion: string | null = null;

  // Wrap the entire body in try/catch so a transient RPC blip surfaces as a
  // structured JSON error and writes a pipeline_runs row, rather than a bare
  // 500 that loses observability. (The route was reportedly 500'ing through
  // a deploy churn window with no log line.)
  try {
    // ── Self-sync newly-paired editions ──────────────────────────────────
    // Pulls fresh dedup pairs from the canonical_pair view into the
    // wmc_dedup_pairs queue. Dedicated RPC because query_sql wraps its
    // argument in `SELECT ... FROM (<input>) t`, which Postgres rejects when
    // <input> is a CTE with a data-modifying statement. RPC returns scalar
    // int.
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

    // ── Drain loop ───────────────────────────────────────────────────────
    while (Date.now() - startedAt < TIME_BUDGET_MS) {
      const { data, error } = await supabaseAdmin.rpc(
        "wmc_edition_key_drain_v3",
        { p_limit: BATCH_SIZE }
      );

      if (error) {
        console.error(
          `[migrate-wmc-edition-keys] drain batch error msg=${error.message} batches=${batchesProcessed} rows_updated=${rowsUpdated}`
        );
        // Surface the failure but keep the rest of the bookkeeping intact —
        // we still want to log a pipeline_runs row below.
        await logPipelineRun({
          startedAt,
          ok: false,
          err: `drain: ${error.message}`,
          pairsSelfSynced,
          rowsUpdated,
          remainingOrphans,
          batchesProcessed,
          algoVersion,
        });
        return NextResponse.json(
          {
            error: error.message,
            batches_processed: batchesProcessed,
            rows_updated: rowsUpdated,
            pairs_self_synced: pairsSelfSynced,
            pairs_remaining: remainingOrphans,
            duration_ms: Date.now() - startedAt,
          },
          { status: 500 }
        );
      }

      // v3 returns jsonb (object). supabase-js surfaces a function-returns-
      // jsonb call as the parsed object directly. Older RPC revisions wrapped
      // the same data in a single-element array; defensively unwrap both.
      const row = (Array.isArray(data) ? data[0] : data) as DrainV3Result | null;

      const rowsMigratedThisBatch = numFrom(
        row?.rows_migrated,
        row?.rows_updated,
        row?.pairs_claimed
      );
      remainingOrphans = numFrom(
        row?.wmc_int_remaining_orphans,
        row?.pairs_remaining
      );
      if (typeof row?.algo_version === "string") algoVersion = row.algo_version;

      rowsUpdated += rowsMigratedThisBatch;
      batchesProcessed += 1;

      // Nothing left to migrate this iteration: queue is empty for this
      // collection / pairing scope. Single-iteration zero is genuine drain
      // because there are no concurrent drainers.
      if (rowsMigratedThisBatch === 0) {
        drained = true;
        break;
      }
    }

    // Final orphan count: prefer the value returned by the last RPC call,
    // fall back to a direct count via query_sql for safety (e.g. if the loop
    // never ran because of a degenerate p_limit).
    if (remainingOrphans == null) {
      try {
        const { data: cnt, error: cntErr } = await supabaseAdmin.rpc(
          "query_sql",
          {
            query: `
              SELECT COUNT(*)::bigint AS cnt
              FROM wallet_moments_cache
              WHERE edition_key ~ '^[0-9]+:[0-9]+$'
            `,
          }
        );
        if (
          !cntErr &&
          Array.isArray(cnt) &&
          cnt[0] &&
          typeof cnt[0].cnt !== "undefined"
        ) {
          remainingOrphans = Number(cnt[0].cnt);
        }
      } catch (err) {
        console.warn(
          "[migrate-wmc-edition-keys] orphan count fallback failed:",
          err instanceof Error ? err.message : err
        );
      }
    }

    const durationMs = Date.now() - startedAt;
    const drainedOrTimedOut = drained ? "drained" : "timed_out";

    console.log(
      `[migrate-wmc-edition-keys] done batches=${batchesProcessed} updated=${rowsUpdated} pairs_self_synced=${pairsSelfSynced} pairs_remaining=${remainingOrphans} status=${drainedOrTimedOut} duration_ms=${durationMs} algo=${algoVersion ?? "unknown"}`
    );

    await logPipelineRun({
      startedAt,
      ok: drained,
      err: drained ? null : "budget exceeded",
      pairsSelfSynced,
      rowsUpdated,
      remainingOrphans,
      batchesProcessed,
      algoVersion,
    });

    return NextResponse.json({
      batches_processed: batchesProcessed,
      rows_updated: rowsUpdated,
      pairs_remaining: remainingOrphans,
      wmc_int_remaining_orphans: remainingOrphans,
      drained_or_timed_out: drainedOrTimedOut,
      duration_ms: durationMs,
      pairs_self_synced: pairsSelfSynced,
      algo_version: algoVersion,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[migrate-wmc-edition-keys] unhandled error msg=${message} batches=${batchesProcessed} rows_updated=${rowsUpdated}`
    );
    await logPipelineRun({
      startedAt,
      ok: false,
      err: `unhandled: ${message}`,
      pairsSelfSynced,
      rowsUpdated,
      remainingOrphans,
      batchesProcessed,
      algoVersion,
    });
    return NextResponse.json(
      {
        error: message,
        batches_processed: batchesProcessed,
        rows_updated: rowsUpdated,
        pairs_self_synced: pairsSelfSynced,
        pairs_remaining: remainingOrphans,
        duration_ms: Date.now() - startedAt,
      },
      { status: 500 }
    );
  }
}

async function logPipelineRun(opts: {
  startedAt: number;
  ok: boolean;
  err: string | null;
  pairsSelfSynced: number;
  rowsUpdated: number;
  remainingOrphans: number | null;
  batchesProcessed: number;
  algoVersion: string | null;
}) {
  try {
    await (supabaseAdmin as any).rpc("log_pipeline_run", {
      p_pipeline: "migrate-wmc-edition-keys",
      p_started_at: new Date(opts.startedAt).toISOString(),
      p_rows_found: opts.pairsSelfSynced,
      p_rows_written: opts.rowsUpdated,
      p_rows_skipped: opts.remainingOrphans ?? 0,
      p_ok: opts.ok,
      p_error: opts.err,
      p_collection_slug: null,
      p_cursor_before: null,
      p_cursor_after: null,
      p_extra: {
        batches_processed: opts.batchesProcessed,
        wmc_int_remaining_orphans: opts.remainingOrphans,
        algo_version: opts.algoVersion,
      },
    });
  } catch (err) {
    console.warn(
      `[migrate-wmc-edition-keys] log_pipeline_run err: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
}

// app/api/admin/migrate-wmc-edition-keys/route.ts
//
// POST — drains wallet_moments_cache.edition_key from the legacy integer
// "set:play" format to the canonical UUID-edition external_id by repeatedly
// calling SECDEF RPC public.wmc_edition_key_drain_v2(limit). The RPC
// self-tracks progress via the wmc_dedup_pairs.processed column, so this
// route no longer manages an offset cursor.
//
// Auth: Bearer RPC_ADMIN_TOKEN (or ?token=) via verifyAdminRequest.
// Idempotent: re-running drains whatever's left. Hard-stops at 250s of
// wall-clock to stay safely under the 300s Vercel maxDuration.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { verifyAdminRequest, adminUnauthorizedResponse } from "@/lib/admin-auth";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

const BATCH_SIZE = 200;
const TIME_BUDGET_MS = 250_000; // 250s — 50s headroom under maxDuration
const DRAIN_WINDOW = 5; // last-N-batches sum-zero ⇒ drained

export async function POST(req: NextRequest) {
  if (!verifyAdminRequest(req)) return adminUnauthorizedResponse();

  const startedAt = Date.now();
  let batchesProcessed = 0;
  let rowsUpdated = 0;
  const recent: number[] = [];
  let drained = false;

  while (Date.now() - startedAt < TIME_BUDGET_MS) {
    const { data, error } = await supabaseAdmin.rpc(
      "wmc_edition_key_drain_v2",
      { p_limit: BATCH_SIZE }
    );

    if (error) {
      console.error(
        `[migrate-wmc-edition-keys] batch error: ${error.message}`
      );
      return NextResponse.json(
        {
          error: error.message,
          batches_processed: batchesProcessed,
          rows_updated: rowsUpdated,
        },
        { status: 500 }
      );
    }

    const updated = Number(data ?? 0);
    rowsUpdated += updated;
    batchesProcessed += 1;

    recent.push(updated);
    if (recent.length > DRAIN_WINDOW) recent.shift();

    if (
      recent.length === DRAIN_WINDOW &&
      recent.reduce((a, b) => a + b, 0) === 0
    ) {
      drained = true;
      break;
    }
  }

  let pairsRemaining: number | null = null;
  try {
    const { data: cnt, error: cntErr } = await supabaseAdmin.rpc("query_sql", {
      query: `
        SELECT COUNT(*)::bigint AS cnt
        FROM wmc_dedup_pairs
        WHERE NOT processed
      `,
    });
    if (!cntErr && Array.isArray(cnt) && cnt[0] && typeof cnt[0].cnt !== "undefined") {
      pairsRemaining = Number(cnt[0].cnt);
    }
  } catch (err) {
    console.warn(
      "[migrate-wmc-edition-keys] pairs_remaining count failed:",
      err instanceof Error ? err.message : err
    );
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
    `[migrate-wmc-edition-keys] done batches=${batchesProcessed} updated=${rowsUpdated} pairs_remaining=${pairsRemaining} wmc_int_remaining_orphans=${wmcIntRemainingOrphans} status=${drainedOrTimedOut} duration_ms=${durationMs}`
  );

  return NextResponse.json({
    batches_processed: batchesProcessed,
    rows_updated: rowsUpdated,
    pairs_remaining: pairsRemaining,
    wmc_int_remaining_orphans: wmcIntRemainingOrphans,
    drained_or_timed_out: drainedOrTimedOut,
    duration_ms: durationMs,
  });
}

// app/api/admin/migrate-wmc-edition-keys/route.ts
//
// POST — drains wallet_moments_cache.edition_key from the legacy integer
// "set:play" format to the canonical UUID-edition external_id, walking the
// editions_canonical_pair view in OFFSET/LIMIT slices.
//
// Calls SECDEF RPC public.wmc_edition_key_drain_batch(offset, limit) per
// batch — see migration `wmc_edition_key_drain_batch_rpc` for the body.
// One DB round-trip per batch; supabase-js wraps each rpc() call in its
// own implicit transaction, which is what we want for incremental progress.
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
  let offset = 0;
  let batchesProcessed = 0;
  let rowsUpdated = 0;
  const recent: number[] = [];
  let drained = false;

  while (Date.now() - startedAt < TIME_BUDGET_MS) {
    const { data, error } = await supabaseAdmin.rpc(
      "wmc_edition_key_drain_batch",
      { p_offset: offset, p_limit: BATCH_SIZE }
    );

    if (error) {
      console.error(
        `[migrate-wmc-edition-keys] batch error offset=${offset}: ${error.message}`
      );
      return NextResponse.json(
        {
          error: error.message,
          batches_processed: batchesProcessed,
          rows_updated: rowsUpdated,
          last_offset: offset,
        },
        { status: 500 }
      );
    }

    const updated = Number(data ?? 0);
    rowsUpdated += updated;
    batchesProcessed += 1;
    offset += BATCH_SIZE;

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

  let remainingIntFormat: number | null = null;
  try {
    const { data: cnt, error: cntErr } = await supabaseAdmin.rpc("query_sql", {
      query: `
        SELECT COUNT(*)::bigint AS cnt
        FROM wallet_moments_cache wmc
        WHERE EXISTS (
          SELECT 1 FROM editions_canonical_pair p
          WHERE p.integer_external_id = wmc.edition_key
            AND p.integer_external_id <> p.canonical_external_id
        )
      `,
    });
    if (!cntErr && Array.isArray(cnt) && cnt[0] && typeof cnt[0].cnt !== "undefined") {
      remainingIntFormat = Number(cnt[0].cnt);
    }
  } catch (err) {
    console.warn(
      "[migrate-wmc-edition-keys] remaining count failed:",
      err instanceof Error ? err.message : err
    );
  }

  const durationMs = Date.now() - startedAt;
  const drainedOrTimedOut = drained ? "drained" : "timed_out";
  const followup =
    drained && remainingIntFormat === 0
      ? "All integer-format edition_keys rewritten. Safe to drop tmp_idx_wmc_edition_key on wallet_moments_cache(edition_key) via a follow-up migration."
      : null;

  console.log(
    `[migrate-wmc-edition-keys] done batches=${batchesProcessed} updated=${rowsUpdated} remaining=${remainingIntFormat} status=${drainedOrTimedOut} duration_ms=${durationMs}`
  );

  return NextResponse.json({
    batches_processed: batchesProcessed,
    rows_updated: rowsUpdated,
    remaining_int_format: remainingIntFormat,
    drained_or_timed_out: drainedOrTimedOut,
    duration_ms: durationMs,
    next_offset: drained ? null : offset,
    followup,
  });
}

import { NextRequest, NextResponse, after } from "next/server";
import { createClient } from "@supabase/supabase-js";

// Refreshes public.topshot_conflated_editions — the interim parallel-conflation
// guard (handoff-2026-06-20-parallel-conflation-phase0-verified). TopShot
// SubEditions share setID:playID and each numbers serials 1..N independently, so
// a single editions row blends parallels' prices -> inflated FMV -> fake "deals".
// The table flags editions where 2+ distinct nft_ids share a serial; the deal
// board (topshot_deals_vs_fmv) excludes them, suppressing fake deals + alerts
// until the subedition re-key lands. The set is slow-moving, so a daily refresh
// is ample. Operator: wire a daily cron-job.org entry with Bearer INGEST_SECRET_TOKEN.
// Pattern mirrors /api/cron/refresh-special-serial-owners-mv.
//
// Also refreshes the sibling deal-board guard topshot_thin_fmv_editions (the thin-data
// FMV flag, audit_20260621_topshot_thin_fmv_deal_flag), so wiring this one cron keeps
// BOTH honesty guards current.

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
) as any;

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const PIPELINE_NAME = "refresh-conflated-editions";

async function run(request: NextRequest) {
  const auth = request.headers.get("authorization");
  if (auth !== `Bearer ${process.env.INGEST_SECRET_TOKEN}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const startedAt = new Date().toISOString();

  // 202 + after(): the detector aggregates 365d of TS sales (can exceed
  // cron-job.org's 30s client cap), so auth stays sync, the refresh + log move
  // into after(), and we return immediately so the entry is never auto-disabled
  // on a timeout. pipeline_runs is the real signal.
  after(async () => {
    const startedMs = Date.now();
    let ok = true;
    let errMsg: string | null = null;
    let flagged = 0;
    let remapped = 0;
    let thinFmvFlagged = 0;
    try {
      // Sweep first: redirect any base-keyed sale whose nft is a known parallel
      // onto its `::subID` edition. This is the durable "periodic historical-remap
      // re-run" (handoff-2026-06-20-conflation-drift-history-backfill-leak) — it
      // catches sub-sales that landed on the base before their nft was resolved in
      // topshot_moment_subeditions, so conflation converges instead of drifting up.
      // Non-fatal: a remap failure must not block the guard refresh below.
      try {
        const rm = await supabaseAdmin.rpc("remap_topshot_base_keyed_parallel_sales");
        if (rm.error) console.log(`[${PIPELINE_NAME}] remap rpc err: ${rm.error.message}`);
        else remapped = Number(rm.data ?? 0);
      } catch (e) {
        console.log(`[${PIPELINE_NAME}] remap rpc threw: ${e instanceof Error ? e.message : String(e)}`);
      }

      const res = await supabaseAdmin.rpc("refresh_topshot_conflated_editions");
      if (res.error) {
        ok = false;
        errMsg = res.error.message;
      } else {
        flagged = Number(res.data ?? 0);
      }

      // Sibling deal-board honesty guard: refresh the thin-data FMV flag set
      // (topshot_thin_fmv_editions, audit_20260621_topshot_thin_fmv_deal_flag).
      // FLAGS (not suppresses) editions whose WAP/mean FMV overshoots the 90d
      // median on <15 sales/90d -> the deal board renders a "thin data" caveat
      // and alerts skip them. Co-located here so the same daily refresh keeps both
      // guards current. Non-fatal: a thin-FMV failure must not fail the conflation
      // refresh or its pipeline_runs signal.
      try {
        const tf = await supabaseAdmin.rpc("refresh_topshot_thin_fmv_editions");
        if (tf.error) console.log(`[${PIPELINE_NAME}] thin-fmv rpc err: ${tf.error.message}`);
        else thinFmvFlagged = Number(tf.data ?? 0);
      } catch (e) {
        console.log(`[${PIPELINE_NAME}] thin-fmv rpc threw: ${e instanceof Error ? e.message : String(e)}`);
      }
    } catch (e) {
      ok = false;
      errMsg = e instanceof Error ? e.message : String(e);
      console.log(`[${PIPELINE_NAME}] refresh rpc threw: ${errMsg}`);
    }

    try {
      await supabaseAdmin.rpc("log_pipeline_run", {
        p_pipeline: PIPELINE_NAME,
        p_started_at: startedAt,
        p_rows_found: flagged,
        p_rows_written: flagged,
        p_rows_skipped: 0,
        p_ok: ok,
        p_error: errMsg,
        p_extra: { duration_ms: Date.now() - startedMs, flagged_editions: flagged, sales_remapped: remapped, thin_fmv_flagged: thinFmvFlagged },
      });
    } catch (logErr) {
      console.log(
        `[${PIPELINE_NAME}] log_pipeline_run err: ${logErr instanceof Error ? logErr.message : String(logErr)}`
      );
    }
  });

  return NextResponse.json(
    { ok: true, accepted: true, pipeline: PIPELINE_NAME },
    { status: 202 }
  );
}

export async function POST(request: NextRequest) {
  return run(request);
}

export async function GET(request: NextRequest) {
  return run(request);
}

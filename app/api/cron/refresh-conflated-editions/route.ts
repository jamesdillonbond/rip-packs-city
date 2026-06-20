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
    try {
      const res = await supabaseAdmin.rpc("refresh_topshot_conflated_editions");
      if (res.error) {
        ok = false;
        errMsg = res.error.message;
      } else {
        flagged = Number(res.data ?? 0);
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
        p_extra: { duration_ms: Date.now() - startedMs, flagged_editions: flagged },
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

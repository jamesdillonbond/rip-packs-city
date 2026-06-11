import { NextRequest, NextResponse, after } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
) as any;

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const PIPELINE_NAME = "refresh-pack-grail-metrics-mv";

async function run(request: NextRequest) {
  const auth = request.headers.get("authorization");
  if (auth !== `Bearer ${process.env.INGEST_SECRET_TOKEN}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const startedAt = new Date().toISOString();

  // 202 + after(): REFRESH MATERIALIZED VIEW CONCURRENTLY can exceed
  // cron-job.org's 30s client cap under DB saturation; auth stays sync, the
  // refresh + log move into after(), and we return immediately so the entry
  // can never be auto-disabled on a timeout. pipeline_runs is the real signal.
  after(async () => {
    const startedMs = Date.now();
    // 2026-06-11: the REFRESH RPC previously sat OUTSIDE this try/catch, so a
    // throw (CONCURRENTLY refresh timing out under saturation, not a returned
    // error) rejected the after() before log_pipeline_run — a silent run while
    // cron-job.org acked green. Capture both the returned-error and thrown cases.
    let ok = true;
    let errMsg: string | null = null;
    try {
      const res = await supabaseAdmin.rpc("refresh_pack_grail_metrics_mv");
      if (res.error) {
        ok = false;
        errMsg = res.error.message;
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
        p_rows_found: 0,
        p_rows_written: 0,
        p_rows_skipped: 0,
        p_ok: ok,
        p_error: errMsg,
        p_extra: { duration_ms: Date.now() - startedMs },
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

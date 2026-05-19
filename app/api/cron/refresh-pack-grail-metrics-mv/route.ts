import { NextRequest, NextResponse } from "next/server";
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
  const startedMs = Date.now();
  const { error } = await supabaseAdmin.rpc("refresh_pack_grail_metrics_mv");

  // Log to pipeline_runs so the alert system sees the run. Without this, the
  // route was firing but pipeline_cadence_watchlist treated it as cron_silent.
  try {
    await supabaseAdmin.rpc("log_pipeline_run", {
      p_pipeline: PIPELINE_NAME,
      p_started_at: startedAt,
      p_rows_found: 0,
      p_rows_written: 0,
      p_rows_skipped: 0,
      p_ok: !error,
      p_error: error?.message ?? null,
      p_extra: { duration_ms: Date.now() - startedMs },
    });
  } catch (logErr) {
    console.log(
      `[${PIPELINE_NAME}] log_pipeline_run err: ${logErr instanceof Error ? logErr.message : String(logErr)}`
    );
  }

  return NextResponse.json({
    ok: !error,
    error: error?.message,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
  });
}

export async function POST(request: NextRequest) {
  return run(request);
}

export async function GET(request: NextRequest) {
  return run(request);
}

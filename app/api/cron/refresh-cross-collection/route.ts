// app/api/cron/refresh-cross-collection/route.ts
//
// Native server-side refresh for the /insights/cross-collection backing tables
// (cross_collection_cohort_mat + cross_collection_ts_set_overlap_mat). These
// had no native cron — they were drifting stale (a Cowork scheduled task was
// the interim stopgap, but it only fires when the desktop app is open). This
// route runs the two refresh RPCs server-side, daily, and logs to pipeline_runs
// so it's monitored like the other ~23 pipelines.
//
// Mirrors the admin-auth pattern of refresh-pack-grail-metrics-mv: Bearer
// INGEST_SECRET_TOKEN, and also accepts ?token= for browser-fired cron triggers
// (cron-job.org). The apex domain 308s -> www, so the cron-job.org URL must use
// www.rippackscity.com.
//
// refresh_cross_collection_cohort_step1 -> { cohort_size, computed_at, ... }
// refresh_cross_collection_cohort_step2 -> { set_overlap_rows, computed_at, ... }
// (both jsonb, no args; verified in pg_proc 2026-06-05).

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
) as any;

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const PIPELINE_NAME = "refresh-cross-collection";

function authorized(request: NextRequest): boolean {
  const token = process.env.INGEST_SECRET_TOKEN;
  if (!token) return false;
  const auth = request.headers.get("authorization");
  if (auth === `Bearer ${token}`) return true;
  // Browser-fired cron fallback: ?token= query param.
  const qp = new URL(request.url).searchParams.get("token");
  return qp === token;
}

async function run(request: NextRequest) {
  if (!authorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const startedAt = new Date().toISOString();
  const startedMs = Date.now();

  // Step 1 then step 2 (step 2 reads from step 1's refreshed cohort table).
  const step1 = await supabaseAdmin.rpc("refresh_cross_collection_cohort_step1");
  const step2 = step1.error
    ? { data: null, error: null }
    : await supabaseAdmin.rpc("refresh_cross_collection_cohort_step2");

  const ok = !step1.error && !step2.error;
  const errMsg = step1.error?.message ?? step2.error?.message ?? null;

  try {
    await supabaseAdmin.rpc("log_pipeline_run", {
      p_pipeline: PIPELINE_NAME,
      p_started_at: startedAt,
      p_rows_found: 0,
      p_rows_written: 0,
      p_rows_skipped: 0,
      p_ok: ok,
      p_error: errMsg,
      p_extra: {
        duration_ms: Date.now() - startedMs,
        step1: step1.data ?? null,
        step2: step2.data ?? null,
      },
    });
  } catch (logErr) {
    console.log(
      `[${PIPELINE_NAME}] log_pipeline_run err: ${logErr instanceof Error ? logErr.message : String(logErr)}`
    );
  }

  return NextResponse.json({
    ok,
    error: errMsg,
    step1: step1.data ?? null,
    step2: step2.data ?? null,
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

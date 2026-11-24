import { NextRequest, NextResponse, after } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { writeInvocationHeartbeat } from "@/lib/pipeline/heartbeat";
import { bearerMatches } from "@/lib/auth/bearer-secret";

// POST /api/admin/cron/refresh-error-triage
// Authorization: Bearer <INGEST_SECRET_TOKEN>
// Hit by cron-job.org every 30 minutes UTC. Calls
// public.refresh_error_triage(p_lookback) which rebuilds the error_triage
// rollup from pipeline_runs + flowty_transactions over the lookback window.

export const maxDuration = 60;
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const auth = req.headers.get("authorization") ?? "";
  if (!process.env.INGEST_SECRET_TOKEN || !bearerMatches(auth, "INGEST_SECRET_TOKEN")) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const startedAtIso = new Date().toISOString();

  // 202 + after(): refresh_error_triage rebuilds a 14-day rollup and can exceed
  // cron-job.org's 30s client cap under DB saturation; auth stays sync, the work
  // + a log_pipeline_run move into after(), and we return immediately so the
  // entry can never be auto-disabled. pipeline_runs is the success signal now.
  after(async () => {
    const startedAt = Date.now();
    // INVOCATION MARKER FIRST (deep-audit E5, 2026-11-23): a maxDuration kill writes no terminal row.
    // Max 10,082 ms of a 60,000 ms wall over 73 h (17 %), after()-only.
    await writeInvocationHeartbeat({ pipeline: "refresh-error-triage", startedAtMs: Date.parse(startedAtIso) });
    let ok = true;
    let errMsg: string | null = null;
    try {
      const { data, error } = await supabaseAdmin.rpc("refresh_error_triage", {
        p_lookback: "14 days",
      });
      if (error) {
        ok = false;
        errMsg = error.message;
        console.log(`[refresh-error-triage] rpc error: ${error.message}`);
      } else {
        console.log(`[refresh-error-triage] ok result=${JSON.stringify(data)}`);
      }
    } catch (err) {
      ok = false;
      errMsg = err instanceof Error ? err.message : String(err);
      console.log(`[refresh-error-triage] fatal: ${errMsg}`);
    }

    try {
      // rows_* are NULL: this lane rebuilds a rollup and counts no rows, so a 0 there was a measurement
      // nobody took (2026-11-23). supabase-js RETURNS errors (R123), so the returned error is read.
      const { error: logError } = await (supabaseAdmin as any).rpc("log_pipeline_run", {
        p_pipeline: "refresh-error-triage",
        p_started_at: startedAtIso,
        p_rows_found: null,
        p_rows_written: null,
        p_rows_skipped: null,
        p_ok: ok,
        p_error: errMsg,
        p_extra: { duration_ms: Date.now() - startedAt },
      });
      if (logError) console.log(`[refresh-error-triage] log_pipeline_run err: ${logError.message}`);
    } catch (logErr) {
      console.log(
        `[refresh-error-triage] log_pipeline_run err: ${logErr instanceof Error ? logErr.message : String(logErr)}`
      );
    }
  });

  return NextResponse.json(
    { ok: true, accepted: true, pipeline: "refresh-error-triage" },
    { status: 202 }
  );
}

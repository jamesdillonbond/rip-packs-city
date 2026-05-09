import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";

// POST /api/admin/cron/refresh-error-triage
// Authorization: Bearer <INGEST_SECRET_TOKEN>
// Hit by cron-job.org every 30 minutes UTC. Calls
// public.refresh_error_triage(p_lookback) which rebuilds the error_triage
// rollup from pipeline_runs + flowty_transactions over the lookback window.

export const maxDuration = 30;
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const auth = req.headers.get("authorization") ?? "";
  if (!process.env.INGEST_SECRET_TOKEN || auth !== `Bearer ${process.env.INGEST_SECRET_TOKEN}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const startedAt = Date.now();

  try {
    const { data, error } = await supabaseAdmin.rpc("refresh_error_triage", {
      p_lookback: "14 days",
    });
    const durationMs = Date.now() - startedAt;

    if (error) {
      console.log(
        `[refresh-error-triage] rpc error: ${error.message} (duration_ms=${durationMs})`
      );
      return NextResponse.json(
        { ok: false, error: error.message, duration_ms: durationMs },
        { status: 500 }
      );
    }

    console.log(
      `[refresh-error-triage] ok duration_ms=${durationMs} result=${JSON.stringify(data)}`
    );

    if (data && typeof data === "object" && !Array.isArray(data)) {
      return NextResponse.json({ ok: true, duration_ms: durationMs, ...data });
    }
    return NextResponse.json({ ok: true, duration_ms: durationMs, result: data ?? null });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`[refresh-error-triage] fatal: ${msg}`);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

import { NextRequest, NextResponse, after } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
) as any;

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const PIPELINE_NAME = "backfill-pack-rip-metadata";

async function run(request: NextRequest) {
  const auth = request.headers.get("authorization");
  if (auth !== `Bearer ${process.env.INGEST_SECRET_TOKEN}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const startedAt = new Date().toISOString();

  // 202 + after(): the backfill RPC can exceed cron-job.org's 30s client cap
  // under DB saturation; auth stays sync, the work + log_pipeline_run move
  // into after(), and we return immediately so the entry can never be
  // auto-disabled on a timeout. pipeline_runs is the real success signal.
  after(async () => {
    const startedMs = Date.now();
    const { data, error } = await supabaseAdmin.rpc("backfill_pack_rip_metadata", {
      p_limit: 500,
    });

    try {
      await supabaseAdmin.rpc("log_pipeline_run", {
        p_pipeline: PIPELINE_NAME,
        p_started_at: startedAt,
        p_rows_found: Number(data?.processed ?? 0),
        p_rows_written: Number(data?.value_resolved ?? 0),
        p_rows_skipped: 0,
        p_ok: !error,
        p_error: error?.message ?? null,
        p_extra: {
          dist_resolved: data?.dist_resolved ?? null,
          value_resolved: data?.value_resolved ?? null,
          duration_ms: Date.now() - startedMs,
        },
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

import { NextRequest, NextResponse, after } from "next/server";
import { createClient } from "@supabase/supabase-js";

// Refreshes topshot_special_serial_owners_mv (backs the Special Serial Owners
// board). The base view full-scans TS wallet_moments_cache (~70s), so the board
// reads the MV; this cron keeps the MV current. Operator: wire a low-cadence
// cron-job.org entry (e.g. daily) hitting this with Bearer INGEST_SECRET_TOKEN.
// Pattern mirrors /api/cron/refresh-pack-grail-metrics-mv.

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
) as any;

export const dynamic = "force-dynamic";
// 240s so the after() lambda outlives the CONCURRENTLY refresh (measured >135s,
// grows with the Stage-B parallel remap; fn statement_timeout is 200s). Was 120,
// which silently killed the refresh before it logged — REFRESH-SPECIAL-SERIAL-
// OWNERS-MV-TIMEOUT. Well under the 800s Pro cap.
export const maxDuration = 240;

const PIPELINE_NAME = "refresh-special-serial-owners-mv";

async function run(request: NextRequest) {
  const auth = request.headers.get("authorization");
  if (auth !== `Bearer ${process.env.INGEST_SECRET_TOKEN}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const startedAt = new Date().toISOString();

  // 202 + after(): REFRESH MATERIALIZED VIEW CONCURRENTLY can exceed cron-job.org's
  // 30s client cap (the underlying full-scan is ~70s), so auth stays sync, the
  // refresh + log move into after(), and we return immediately so the entry can
  // never be auto-disabled on a timeout. pipeline_runs is the real signal.
  after(async () => {
    const startedMs = Date.now();
    let ok = true;
    let errMsg: string | null = null;
    try {
      const res = await supabaseAdmin.rpc("refresh_topshot_special_serial_owners_mv");
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

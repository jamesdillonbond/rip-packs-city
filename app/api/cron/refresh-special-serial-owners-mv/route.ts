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
// 240s lets the after() lambda outlive the ~125s CONCURRENTLY refresh; well under
// the 800s Pro cap. The route no longer interprets the RPC's HTTP result.
export const maxDuration = 240;

const PIPELINE_NAME = "refresh-special-serial-owners-mv";

async function run(request: NextRequest) {
  const auth = request.headers.get("authorization");
  if (auth !== `Bearer ${process.env.INGEST_SECRET_TOKEN}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Thin trigger. The ~125s CONCURRENTLY refresh exceeds Supabase's ~120s
  // API-gateway request timeout, so a synchronous PostgREST call always 504s
  // ("upstream request timeout") even though the backend completes and COMMITs
  // the refresh — that false-negative was REFRESH-SPECIAL-SERIAL-OWNERS-MV-
  // TIMEOUT. The SQL function (audit_20260622_refresh_special_serial_owners_mv_
  // self_log) now self-logs its own authoritative pipeline_runs row server-side
  // (ok=true after the refresh commits; ok=false on a caught error). So here we
  // only fire-and-forget and swallow the expected gateway timeout — writing a
  // log row from the route would just duplicate (and contradict) the function's.
  after(async () => {
    try {
      await supabaseAdmin.rpc("refresh_topshot_special_serial_owners_mv");
    } catch (e) {
      console.log(
        `[${PIPELINE_NAME}] trigger threw (refresh self-logs server-side): ${
          e instanceof Error ? e.message : String(e)
        }`
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

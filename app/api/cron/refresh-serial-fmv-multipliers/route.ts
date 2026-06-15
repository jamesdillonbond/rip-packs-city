import { NextRequest, NextResponse, after } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
) as any;

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const PIPELINE_NAME = "refresh-serial-fmv-multipliers";

// Weekly refresh of the serial_fmv_multipliers table (Phase 2 serial-adjusted
// FMV). One cheap full pass over 180d of sales; keeps the #1 / perfect-mint
// premium cells current as the sales base grows. Read-only inputs, additive
// output — never touches edition FMV. Top Shot only for now (the fn default);
// add an AllDay pass here once compute_serial_fmv_multipliers('<allday_uuid>')
// is validated against LiveToken.
async function run(request: NextRequest) {
  const auth = request.headers.get("authorization");
  if (auth !== `Bearer ${process.env.INGEST_SECRET_TOKEN}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const startedAt = new Date().toISOString();

  after(async () => {
    const startedMs = Date.now();
    let ok = true;
    let errMsg: string | null = null;
    let rows = 0;
    try {
      const res = await supabaseAdmin.rpc("compute_serial_fmv_multipliers");
      if (res.error) {
        ok = false;
        errMsg = res.error.message;
      } else if (typeof res.data === "number") {
        rows = res.data;
      }
    } catch (e) {
      ok = false;
      errMsg = e instanceof Error ? e.message : String(e);
      console.log(`[${PIPELINE_NAME}] compute rpc threw: ${errMsg}`);
    }

    try {
      await supabaseAdmin.rpc("log_pipeline_run", {
        p_pipeline: PIPELINE_NAME,
        p_started_at: startedAt,
        p_rows_found: rows,
        p_rows_written: rows,
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

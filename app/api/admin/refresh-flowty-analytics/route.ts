import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";

// POST /api/admin/refresh-flowty-analytics
// Authorization: Bearer <INGEST_SECRET_TOKEN | CRON_SECRET>
// Hit by cron-job.org every 20 minutes UTC. Calls the
// public.refresh_flowty_analytics() RPC which concurrently refreshes the
// three Flowty analytics materialized views and returns a JSONB summary.

export const maxDuration = 60;
export const dynamic = "force-dynamic";

function isAuthorized(req: NextRequest): boolean {
  const auth = req.headers.get("authorization") ?? "";
  const ingest = process.env.INGEST_SECRET_TOKEN;
  const cron = process.env.CRON_SECRET;
  if (ingest && auth === `Bearer ${ingest}`) return true;
  if (cron && auth === `Bearer ${cron}`) return true;
  return false;
}

export async function POST(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const startedAt = Date.now();

  try {
    const { data, error } = await supabaseAdmin.rpc("refresh_flowty_analytics");
    const durationMs = Date.now() - startedAt;

    if (error) {
      console.log(
        `[refresh-flowty-analytics] rpc error: ${error.message} (duration_ms=${durationMs})`
      );
      return NextResponse.json(
        { ok: false, error: error.message, duration_ms: durationMs },
        { status: 500 }
      );
    }

    console.log(
      `[refresh-flowty-analytics] ok duration_ms=${durationMs} result=${JSON.stringify(data)}`
    );

    if (data && typeof data === "object" && !Array.isArray(data)) {
      return NextResponse.json({ ok: true, duration_ms: durationMs, ...data });
    }
    return NextResponse.json({ ok: true, duration_ms: durationMs, result: data ?? null });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`[refresh-flowty-analytics] fatal: ${msg}`);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

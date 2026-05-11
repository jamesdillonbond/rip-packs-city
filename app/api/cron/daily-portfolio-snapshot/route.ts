// app/api/cron/daily-portfolio-snapshot/route.ts
//
// Cron entrypoint for the daily per-user portfolio snapshot. Schedule on
// cron-job.org once per day at 06:00 UTC (`0 6 * * *`). Bearer
// INGEST_SECRET_TOKEN / CRON_SECRET, or `?token=` query for browser
// triggers.
//
// Calls snapshot_all_user_portfolios() which walks saved_wallets and
// writes one portfolio_snapshots row per (user, day).

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization") ?? "";
  const queryToken = req.nextUrl.searchParams.get("token");
  const ingestSecret = process.env.INGEST_SECRET_TOKEN;
  const cronSecret = process.env.CRON_SECRET;

  const isValid =
    (ingestSecret && authHeader === `Bearer ${ingestSecret}`) ||
    (cronSecret && authHeader === `Bearer ${cronSecret}`) ||
    (ingestSecret && queryToken === ingestSecret);

  if (!isValid) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const startedAt = Date.now();
  try {
    const { data, error } = await supabaseAdmin.rpc("snapshot_all_user_portfolios");
    if (error) {
      console.log(`[cron/daily-portfolio-snapshot] rpc error: ${error.message}`);
      return NextResponse.json(
        { ok: false, error: error.message, elapsed_ms: Date.now() - startedAt },
        { status: 500 }
      );
    }
    return NextResponse.json({
      ok: true,
      result: data ?? null,
      elapsed_ms: Date.now() - startedAt,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`[cron/daily-portfolio-snapshot] fatal: ${msg}`);
    return NextResponse.json(
      { ok: false, error: msg, elapsed_ms: Date.now() - startedAt },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  return GET(req);
}

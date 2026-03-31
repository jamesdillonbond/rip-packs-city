import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
) as any;

export const dynamic = "force-dynamic";
export const maxDuration = 10;

const STALE_THRESHOLD_MINUTES = 45;

export async function GET(request: NextRequest) {
  const auth = request.headers.get("authorization");
  if (auth !== `Bearer ${process.env.INGEST_SECRET_TOKEN}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { data, error } = await supabaseAdmin.rpc("health_check");

    if (error) {
      console.error("[stale-fmv-monitor] health_check RPC failed:", error.message);
      return NextResponse.json({ status: "error", error: error.message }, { status: 500 });
    }

    const staleMinutes = Math.round(data.fmv_pipeline.staleness_minutes);
    const isStale = staleMinutes > STALE_THRESHOLD_MINUTES;
    const lastSaleAge = data.sales_pipeline.last_sale_at
      ? Math.round(
          (Date.now() - new Date(data.sales_pipeline.last_sale_at).getTime()) /
            60000
        )
      : null;

    if (isStale) {
      console.error(
        `[ALERT] FMV STALE — ${staleMinutes} min since last compute (threshold: ${STALE_THRESHOLD_MINUTES} min). ` +
          `Coverage: ${data.fmv_pipeline.coverage_pct}%. ` +
          `Last sale: ${lastSaleAge} min ago.`
      );
    } else {
      console.log(
        `[stale-fmv-monitor] OK — FMV ${staleMinutes} min old, ` +
          `${data.fmv_pipeline.editions_covered}/${data.fmv_pipeline.total_editions} editions, ` +
          `${data.sales_pipeline.sales_last_24h} sales/24h`
      );
    }

    if (!data.data_integrity.orphaned_editions_ok) {
      console.warn(
        `[ALERT] DATA INTEGRITY — ` +
          `${data.data_integrity.editions_no_set} editions missing set, ` +
          `${data.data_integrity.editions_no_player} editions missing player (non-Unknown)`
      );
    }

    return NextResponse.json({
      status: isStale ? "stale" : "ok",
      fmv_staleness_minutes: staleMinutes,
      fmv_threshold_minutes: STALE_THRESHOLD_MINUTES,
      fmv_coverage_pct: data.fmv_pipeline.coverage_pct,
      sales_last_24h: data.sales_pipeline.sales_last_24h,
      last_sale_age_minutes: lastSaleAge,
      data_integrity_ok: data.data_integrity.orphaned_editions_ok,
      db_size_mb: data.database.size_mb,
      rls_coverage_pct: data.database.rls_coverage_pct,
      checked_at: data.checked_at,
    });
  } catch (err: any) {
    console.error("[stale-fmv-monitor] Unexpected error:", err.message);
    return NextResponse.json({ status: "error", error: err.message }, { status: 500 });
  }
}

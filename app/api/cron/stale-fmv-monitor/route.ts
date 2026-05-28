import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
) as any;

export const dynamic = "force-dynamic";
export const maxDuration = 10;

const STALE_THRESHOLD_MINUTES = 45;

// Read the inputs we need directly. The historical health_check() shape this
// route used to consume (fmv_pipeline.staleness_minutes, sales_pipeline.last_sale_at,
// data_integrity.orphaned_editions_ok, database.size_mb, database.rls_coverage_pct)
// no longer exists on the RPC — current health_check() exposes a flat fmv block
// + per-collection sales_24h and a top-level db_size_mb. Rather than wedging
// the old keys back onto the RPC, the route just queries each metric directly.
export async function GET(request: NextRequest) {
  const ingestToken = process.env.INGEST_SECRET_TOKEN;
  if (!ingestToken) {
    return NextResponse.json(
      { error: "Server misconfigured: INGEST_SECRET_TOKEN not set" },
      { status: 500 }
    );
  }

  const auth = request.headers.get("authorization");
  const token = auth?.replace(/^Bearer\s+/i, "") ?? "";
  const allowed = [ingestToken, process.env.CRON_SECRET].filter(Boolean);
  if (!allowed.includes(token)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const [latestFmvRes, latestSaleRes, editionsCountRes, fmvCoverRes, orphanSetRes, orphanPlayerRes] = await Promise.all([
      supabaseAdmin
        .from("fmv_snapshots")
        .select("computed_at")
        .order("computed_at", { ascending: false })
        .limit(1),
      supabaseAdmin
        .from("sales")
        .select("sold_at")
        .order("sold_at", { ascending: false })
        .limit(1),
      supabaseAdmin
        .from("editions")
        .select("id", { count: "exact", head: true }),
      supabaseAdmin
        .from("fmv_snapshots")
        .select("edition_id", { count: "exact", head: true }),
      supabaseAdmin
        .from("editions")
        .select("id", { count: "exact", head: true })
        .is("set_id", null),
      supabaseAdmin
        .from("editions")
        .select("id", { count: "exact", head: true })
        .is("player_id", null),
    ]);

    if (latestFmvRes.error || !latestFmvRes.data?.[0]?.computed_at) {
      return NextResponse.json({ status: "error", error: "no fmv_snapshots rows" }, { status: 500 });
    }

    const now = Date.now();
    const latestFmvMs = new Date(latestFmvRes.data[0].computed_at).getTime();
    const staleMinutes = Math.round((now - latestFmvMs) / 60000);
    const isStale = staleMinutes > STALE_THRESHOLD_MINUTES;

    const latestSaleAt = latestSaleRes.data?.[0]?.sold_at ?? null;
    const lastSaleAge = latestSaleAt
      ? Math.round((now - new Date(latestSaleAt).getTime()) / 60000)
      : null;

    const totalEditions = editionsCountRes.count ?? 0;
    const fmvCovered = fmvCoverRes.count ?? 0;
    const coveragePct = totalEditions > 0
      ? Number(((fmvCovered / totalEditions) * 100).toFixed(1))
      : 0;

    const orphanSet = orphanSetRes.count ?? 0;
    const orphanPlayer = orphanPlayerRes.count ?? 0;
    const dataIntegrityOk = orphanSet === 0 && orphanPlayer === 0;

    if (isStale) {
      console.error(
        `[ALERT] FMV STALE — ${staleMinutes} min since last compute (threshold: ${STALE_THRESHOLD_MINUTES} min). ` +
          `Coverage: ${coveragePct}%. Last sale: ${lastSaleAge} min ago.`
      );
    } else {
      console.log(
        `[stale-fmv-monitor] OK — FMV ${staleMinutes} min old, ${fmvCovered}/${totalEditions} editions covered (${coveragePct}%)`
      );
    }

    if (!dataIntegrityOk) {
      console.warn(
        `[ALERT] DATA INTEGRITY — ${orphanSet} editions missing set, ${orphanPlayer} editions missing player`
      );
    }

    return NextResponse.json({
      status: isStale ? "stale" : "ok",
      fmv_staleness_minutes: staleMinutes,
      fmv_threshold_minutes: STALE_THRESHOLD_MINUTES,
      fmv_coverage_pct: coveragePct,
      editions_covered: fmvCovered,
      total_editions: totalEditions,
      last_sale_age_minutes: lastSaleAge,
      data_integrity_ok: dataIntegrityOk,
      editions_no_set: orphanSet,
      editions_no_player: orphanPlayer,
      checked_at: new Date(now).toISOString(),
    });
  } catch (err: any) {
    console.error("[stale-fmv-monitor] Unexpected error:", err.message);
    return NextResponse.json({ status: "error", error: err.message }, { status: 500 });
  }
}

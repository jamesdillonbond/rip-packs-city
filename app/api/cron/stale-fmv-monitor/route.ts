import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
) as any;

export const dynamic = "force-dynamic";
// Was 10s — too tight. The route fires several parallel reads and runs at the
// :13/:43 cron-saturation windows, so it intermittently 504'd (verified in Vercel
// logs). 30s gives comfortable headroom now that the heavy count is gone.
export const maxDuration = 30;

const STALE_THRESHOLD_MINUTES = 45;

// Reads the inputs we need directly (the historical health_check() shape this route
// used to consume no longer exists on the RPC).
//
// 2026-06-26 fix — removed the load-bearing failure: this route used to run
// `from("fmv_snapshots").select("edition_id", { count: "exact", head: true })`,
// an UNFILTERED count(*) over the ~700k-row partitioned fmv_snapshots table
// (~388ms calm, multiple seconds under cron-window load) that tipped the 10s
// lambda into 504 → the "RPC Ops Monitor" GHA `exit 1`. It was also a broken
// metric: it counted every snapshot row (~700k), not editions covered, so
// fmv_coverage_pct read ~2,800%. Dropped it. The remaining reads are the cheap,
// index-backed latest-row lookups (~2ms) plus three small counts over the ~24k
// editions table. Pass/fail for the GHA only depends on HTTP 200 + `status`, both
// of which the staleness check alone determines.
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
    const [latestFmvRes, latestSaleRes, editionsCountRes, orphanSetRes, orphanPlayerRes] =
      await Promise.all([
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
          .from("editions")
          .select("id", { count: "exact", head: true })
          .is("set_id", null),
        supabaseAdmin
          .from("editions")
          .select("id", { count: "exact", head: true })
          .is("player_id", null),
      ]);

    if (latestFmvRes.error || !latestFmvRes.data?.[0]?.computed_at) {
      return NextResponse.json(
        { status: "error", error: latestFmvRes.error?.message ?? "no fmv_snapshots rows" },
        { status: 500 }
      );
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
    const orphanSet = orphanSetRes.count ?? 0;
    const orphanPlayer = orphanPlayerRes.count ?? 0;
    const dataIntegrityOk = orphanSet === 0 && orphanPlayer === 0;

    if (isStale) {
      console.error(
        `[ALERT] FMV STALE — ${staleMinutes} min since last compute (threshold: ${STALE_THRESHOLD_MINUTES} min). ` +
          `Last sale: ${lastSaleAge} min ago.`
      );
    } else {
      console.log(
        `[stale-fmv-monitor] OK — FMV ${staleMinutes} min old, ${totalEditions} editions, last sale ${lastSaleAge} min ago`
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

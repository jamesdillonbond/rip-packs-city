import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { sendOpsAlert } from "@/lib/ops-alert";

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
) as any;

export const dynamic = "force-dynamic";
// Was 10s — too tight. The route fires several parallel reads and runs at the
// :13/:43 cron-saturation windows, so it intermittently 504'd (verified in Vercel
// logs). 30s gives comfortable headroom now that the heavy count is gone.
// Raised 30 -> 60 (deep-audit D7): under disk-IO saturation this route 504'd on
// 20 of 49 ticks (40.8%) over 30h, so an FMV-staleness alarm was itself down two
// ticks in five. It is a read-only, fully idempotent health check, so a longer
// budget costs nothing and a re-run is free. Same remedy as price-snapshots
// (15 -> 60) and sentinel (60 -> 180).
export const maxDuration = 60;

const STALE_THRESHOLD_MINUTES = 45;

// The "last sale" read is DIAGNOSTIC CONTEXT ONLY (it tells you whether stale FMV
// means the recalc broke or the sales feed dried up). It must never be allowed to
// cost more than the check it annotates.
//
// 2026-08-04 fix — this route was 504'ing every tick (RPC Ops Monitor red on 6 of
// its last 8 runs, all 3 retries exhausted, FMV staleness effectively unmonitored
// for most of the day). Measured live, the culprit was ONE leg:
//
//   SELECT sold_at FROM sales ORDER BY sold_at DESC LIMIT 1   ->  17,067 ms
//
// `sales` is year-partitioned and NO partition has a sold_at-LEADING index (they
// all lead with edition_id or collection_id), so an unbounded ORDER BY sold_at
// cannot do a per-partition backward scan + MergeAppend. Postgres instead read all
// ~4.7M rows across 8 partitions (336,469 buffers) into a top-N heapsort. For
// comparison the sibling fmv_snapshots read, which DOES have a computed_at DESC
// index, is 2.07 ms, and the three editions counts are ~25 ms each — none of them
// were ever the problem.
//
// Bounding the window makes sold_at prunable (verified: "Subplans Removed: 6",
// only sales_2026 + the empty sales_2027 remain) and drops it to ~1,993 ms.
// Deliberately NOT fixed by adding a sold_at index: sales is a hot append table,
// CREATE INDEX CONCURRENTLY cannot run inside apply_migration, and a new partition
// each year would need the index re-created — real recurring cost to serve one
// diagnostic field. Deliberately NOT fixed by VACUUM either: the residual 3,925
// heap fetches are stale-visibility-map, but sales_2026's non-all-visible pages are
// FRESH APPEND pages, so a vacuum would decay within hours (assessed 2026-08-04).
//
// ⚠ Do not "simplify" this by querying sales_2026 directly — a hardcoded partition
// silently returns nothing once the date rolls into 2027 (that exact class was swept
// out of two other routes on 2026-08-04). Always read the parent and let pruning work.
const LAST_SALE_WINDOW_DAYS = 2;

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

  // deep-audit D7: this route had NO log_pipeline_run anywhere, so an FMV-staleness
  // ALARM that was itself failing 40.8% of ticks (29x200 / 20x504 over 30h) said
  // nothing about it — the one instrument that would have shown the alarm was down
  // is the one it did not write to. detect_stalled_pipelines() cannot see a route
  // that never logs at all.
  //
  // WARNING: logging alone does NOT capture the 504s — a run killed at maxDuration
  // never reaches the catch, so it still writes nothing. That is why maxDuration
  // was ALSO raised (see above). Logging makes every run that RETURNS visible; the
  // budget bump is what stops most kills happening in the first place.
  const startedMs = Date.now();
  async function logRun(ok: boolean, extra: Record<string, unknown>, errorMsg: string | null) {
    try {
      await supabaseAdmin.rpc("log_pipeline_run", {
        p_pipeline: "stale-fmv-monitor",
        p_ok: ok,
        p_rows_found: 0,
        p_rows_written: 0,
        p_duration_ms: Date.now() - startedMs,
        p_error: errorMsg,
        p_extra: extra,
      });
    } catch (e) {
      // Never let telemetry break the check it is measuring.
      console.error("[stale-fmv-monitor] log_pipeline_run failed:", e);
    }
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
          .gte(
            "sold_at",
            new Date(Date.now() - LAST_SALE_WINDOW_DAYS * 86400_000).toISOString()
          )
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
    // NOTE: null here now means "no sale inside LAST_SALE_WINDOW_DAYS", NOT
    // "unknown" and NOT "no sales ever" — the read is deliberately bounded (see
    // the constant). Callers get last_sale_window_days alongside so the two are
    // distinguishable; every message below says "in Nd" rather than implying an
    // unbounded lookback.
    const lastSaleAge = latestSaleAt
      ? Math.round((now - new Date(latestSaleAt).getTime()) / 60000)
      : null;
    const lastSaleText =
      lastSaleAge != null
        ? `${lastSaleAge} min ago`
        : `none in the last ${LAST_SALE_WINDOW_DAYS}d`;

    const totalEditions = editionsCountRes.count ?? 0;
    const orphanSet = orphanSetRes.count ?? 0;
    const orphanPlayer = orphanPlayerRes.count ?? 0;
    const dataIntegrityOk = orphanSet === 0 && orphanPlayer === 0;

    if (isStale) {
      console.error(
        `[ALERT] FMV STALE — ${staleMinutes} min since last compute (threshold: ${STALE_THRESHOLD_MINUTES} min). ` +
          `Last sale: ${lastSaleText}.`
      );
      // Push to ops channels — previously only a GitHub ::warning::. Debounced
      // 3h so a stale window (this cron runs every 30 min) pages at most once
      // per 3h instead of every tick.
      await sendOpsAlert({
        key: "fmv-stale",
        cooldownMinutes: 180,
        subject: `\u{1F6A8} RPC FMV stale — ${staleMinutes}m`,
        text:
          `FMV has not recomputed in ${staleMinutes} min (threshold ${STALE_THRESHOLD_MINUTES} min). ` +
          `Last sale ${lastSaleText}. Check the fmv-recalc pipeline / cron-job.org triggers.`,
      });
    } else {
      console.log(
        `[stale-fmv-monitor] OK — FMV ${staleMinutes} min old, ${totalEditions} editions, last sale ${lastSaleText}`
      );
    }

    if (!dataIntegrityOk) {
      console.warn(
        `[ALERT] DATA INTEGRITY — ${orphanSet} editions missing set, ${orphanPlayer} editions missing player`
      );
    }

    // ok=true means THE CHECK RAN, not that FMV is fresh — a stale reading is a
    // successful measurement. Staleness itself is carried in `extra` and alerted
    // above, so this row can never be misread as "the monitor is broken".
    await logRun(true, {
      stale: isStale,
      fmv_staleness_minutes: staleMinutes,
      threshold_minutes: STALE_THRESHOLD_MINUTES,
      total_editions: totalEditions,
      data_integrity_ok: dataIntegrityOk,
    }, null);

    return NextResponse.json({
      status: isStale ? "stale" : "ok",
      fmv_staleness_minutes: staleMinutes,
      fmv_threshold_minutes: STALE_THRESHOLD_MINUTES,
      total_editions: totalEditions,
      // null = no sale inside the window below, NOT "unknown". Ship the window
      // with the value so a consumer can tell those apart.
      last_sale_age_minutes: lastSaleAge,
      last_sale_window_days: LAST_SALE_WINDOW_DAYS,
      data_integrity_ok: dataIntegrityOk,
      editions_no_set: orphanSet,
      editions_no_player: orphanPlayer,
      checked_at: new Date(now).toISOString(),
    });
  } catch (err: any) {
    console.error("[stale-fmv-monitor] Unexpected error:", err.message);
    await logRun(false, { stage: "check" }, err?.message ?? String(err));
    return NextResponse.json({ status: "error", error: err.message }, { status: 500 });
  }
}

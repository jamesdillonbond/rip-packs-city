import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { apiErrorResponse } from "@/lib/api-error";
import { logTerminalRun } from "@/lib/pipeline/terminal-run";

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
) as any;

export const dynamic = "force-dynamic";
// Bumped 15 -> 60 on 2026-08-08: populate_price_snapshots_hourly() aggregates a
// 1-hour window of sales_2026 (a sold_at range with no collection filter, which
// can't ride the (collection_id, sold_at) index and scans wide), so under pooler
// saturation it exceeded the 15s cap and 504'd — dropping that hour's OHLC bucket
// (measured 7 of 24 recent hourly buckets missing, feeding gappy FMV charts). The
// RPC only ever writes the PRIOR hour and is idempotent (ON CONFLICT DO NOTHING),
// so a longer budget is risk-free and the write completes server-side even if the
// cron caller disconnects first. Follow-up (logic change, not done): add
// `edition_id IS NOT NULL AND price_usd > 0` to the RPC's WHERE so it can use the
// idx_sales_2026_fmv_recalc_window partial index (also drops junk from OHLC).
export const maxDuration = 60;

// The pipeline_runs name. Stable and route-owned — NOT the workflow step label,
// which can be renamed without anyone noticing the telemetry key moved.
const PIPELINE = "price-snapshots";

export async function POST(request: NextRequest) {
  const startTime = Date.now();
  const auth = request.headers.get("authorization");
  if (auth !== `Bearer ${process.env.INGEST_SECRET_TOKEN}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { data, error } = await supabaseAdmin.rpc(
      "populate_price_snapshots_hourly"
    );

    if (error) {
      console.error("[price-snapshots] RPC failed:", error.message);
      // ⚠ EVERY exit path past auth logs. Until this row existed there was no
      // durable record that this endpoint had run AT ALL, so a 504 under pooler
      // saturation — the documented failure above — left the missing OHLC bucket
      // as the only evidence, and only if someone happened to look at a chart.
      await logTerminalRun({
        pipeline: PIPELINE,
        startedAt: startTime,
        ok: false,
        error: `populate_price_snapshots_hourly: ${error.message}`,
        extra: { stage: "rpc" },
      });
      return NextResponse.json(
        { status: "error", error: error.message },
        { status: 500 }
      );
    }

    console.log(
      `[price-snapshots] ${data.editions_snapshotted} editions snapshotted for bucket ${data.bucket}`
    );

    await logTerminalRun({
      pipeline: PIPELINE,
      startedAt: startTime,
      ok: true,
      // A MEASURED count, read from the RPC's own return — not a `?? 0` guard.
      // If the RPC ever stops returning it the field goes NULL, which reads as
      // "not measured" rather than as a snapshot-less hour.
      rowsWritten:
        typeof data?.editions_snapshotted === "number" ? data.editions_snapshotted : null,
      extra: { stage: "done", bucket: data?.bucket ?? null },
    });

    return NextResponse.json({ status: "ok", ...data });
  } catch (err: any) {
    console.error("[price-snapshots] Unexpected error:", err.message);
    await logTerminalRun({
      pipeline: PIPELINE,
      startedAt: startTime,
      ok: false,
      error: String(err?.message ?? err),
      extra: { stage: "fatal" },
    });
    return NextResponse.json(
      { status: "error", error: err.message },
      { status: 500 }
    );
  }
}

// ── THIS PROBE IS ANONYMOUSLY REACHABLE, AND IT USED TO INVENT ITS ANSWER ──
//
// `isPublicPath` returns true for all of /api/cron/*, so the proxy steps aside
// and lets the route's OWN bearer check be the gate. POST has one. **GET is
// declared with no parameters at all**, so it cannot read a header, a cookie or
// a query param — it cannot authenticate anyone, and every caller reaches this
// body. It is a public endpoint that looks like an internal one.
//
// Both reads discarded their `error`. supabase-js RETURNS errors rather than
// throwing, so the try/catch below never saw them and the failure rendered as
// DATA: `total_snapshots: count ?? 0` published a measured **zero** out of a
// statement timeout, `latest_bucket`/`staleness_hours` went null, and the whole
// thing was stamped `status: "ok"`. A monitor reading this during an outage is
// told the snapshot table is empty and fresh-unknown, which is worse than an
// error — an error is actionable.
//
// Three states, not two: read FAILED (503, below) · read ok + genuinely EMPTY
// (count 0, no bucket — `.maybeSingle()` so zero rows is not an error) · read
// ok. `.single()` errors on an empty table, which is why it could not tell the
// first two apart and why this now uses `.maybeSingle()`.
//
// The catch published `err.message` — Postgres's own text — to anyone. That is
// the documented driver-message leak; the guard that bans it excludes
// /api/cron/** on the reasoning that a bearer check turns anon away first,
// which is true of POST and false of this handler.
export async function GET() {
  try {
    // `count: "exact"` was requested here and never read — an exact count over
    // the whole table on every probe, for a value the body does not contain.
    const { data, error: latestErr } = await supabaseAdmin
      .from("price_snapshots")
      .select("bucket")
      .order("bucket", { ascending: false })
      .limit(1)
      .maybeSingle();

    const { count, error: countErr } = await supabaseAdmin
      .from("price_snapshots")
      .select("id", { count: "exact", head: true });

    const readErr = latestErr ?? countErr;
    if (readErr) return apiErrorResponse(readErr, "api/cron/price-snapshots");
    // A null count with no error is the third state: the read came back but
    // carries no measurement. Reporting it as 0 is the same fabrication.
    if (count == null) {
      return apiErrorResponse(
        { message: "price_snapshots count unavailable" },
        "api/cron/price-snapshots"
      );
    }

    return NextResponse.json({
      status: "ok",
      total_snapshots: count,
      latest_bucket: data?.bucket ?? null,
      staleness_hours: data?.bucket
        ? Math.round(
            (Date.now() - new Date(data.bucket).getTime()) / 3600000
          )
        : null,
    });
  } catch (err: unknown) {
    return apiErrorResponse(err, "api/cron/price-snapshots");
  }
}

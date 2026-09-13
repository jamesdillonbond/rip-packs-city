// app/api/cron/daily-portfolio-snapshot/route.ts
//
// Cron entrypoint for the daily per-user portfolio snapshot. Schedule on
// cron-job.org once per day at 06:00 UTC (`0 6 * * *`). Bearer
// INGEST_SECRET_TOKEN / CRON_SECRET, or `?token=` query for browser
// triggers.
//
// Calls snapshot_all_user_portfolios() which walks saved_wallets and
// writes one portfolio_snapshots row per (user, day).

import { NextRequest, NextResponse, after } from "next/server";
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

  const startedAtIso = new Date().toISOString();

  // 202 + after(): snapshotting every user portfolio (maxDuration=300) can
  // exceed cron-job.org's 30s client cap; auth stays sync, the work + a
  // log_pipeline_run move into after(), and we return immediately so the entry
  // can never be auto-disabled on a timeout. pipeline_runs is the success
  // signal now that the HTTP status is always 202.
  after(async () => {
    const startedAt = Date.now();
    let ok = true;
    let errMsg: string | null = null;
    let result: any = null;
    try {
      const { data, error } = await supabaseAdmin.rpc("snapshot_all_user_portfolios");
      if (error) {
        ok = false;
        errMsg = error.message;
        console.log(`[cron/daily-portfolio-snapshot] rpc error: ${error.message}`);
      } else {
        result = data ?? null;
      }
    } catch (err) {
      ok = false;
      errMsg = err instanceof Error ? err.message : String(err);
      console.log(`[cron/daily-portfolio-snapshot] fatal: ${errMsg}`);
    }

    // 🚨 `inserted` IS THE KEY `snapshot_all_user_portfolios()` ACTUALLY RETURNS,
    // and reading only the two it does not meant this lane logged
    // `rows_written = 0` on EVERY run while writing 22–25 rows a day. Measured
    // 2026-09-13: the newest ok run logged 0 against its own
    // `extra.result = {"inserted": 25, "snapshot_date": "2026-09-13"}`, and
    // `portfolio_snapshots` holds exactly 25 rows for that date. ⭐ The real count
    // was sitting in the SAME object the fallback chain was reading.
    //
    // ⛔ That is CLAUDE.md's `?? 0` fabricated-number shape: a key that is absent
    // is not a measurement of zero, and publishing it as one made a working
    // user-facing lane read as a dead one to every rollup and to the Zero-Yield
    // arm. ⭐ The correct chain already existed one directory away —
    // `classify-acquisitions-multicollection` reads `inserted` and reports 1,194
    // rows over 58 runs. It was the FIX that failed to spread, not the defect.
    //
    // ⚠ An UNRECOGNISED shape now logs NULL, not 0. `rows_written = 0` is meant to
    // mean a MEASURED zero — the column is nullable precisely so "unmeasured" has
    // its own value — while an explicit `inserted: 0` still logs 0, because that
    // one IS measured. Safe for the consumers: the zero-yield arm sums over
    // `pipeline_runs_daily` (sum ignores NULL) and keys `last_find` on rows_found.
    const writtenRaw =
      result?.inserted ?? result?.snapshots_written ?? result?.rows_written;
    const rowsWritten =
      writtenRaw == null || !Number.isFinite(Number(writtenRaw))
        ? null
        : Number(writtenRaw);

    try {
      await (supabaseAdmin as any).rpc("log_pipeline_run", {
        p_pipeline: "daily-portfolio-snapshot",
        p_started_at: startedAtIso,
        // ⚠ The RPC reports no "found" count at all, so this 0 is not a
        // measurement either — left as-is rather than changed silently, because
        // unlike rows_written no defect has been measured behind it.
        p_rows_found: 0,
        p_rows_written: rowsWritten,
        p_rows_skipped: 0,
        p_ok: ok,
        p_error: errMsg,
        p_extra: { result, duration_ms: Date.now() - startedAt },
      });
    } catch (logErr) {
      console.log(
        `[cron/daily-portfolio-snapshot] log_pipeline_run err: ${logErr instanceof Error ? logErr.message : String(logErr)}`
      );
    }
  });

  return NextResponse.json(
    { ok: true, accepted: true, pipeline: "daily-portfolio-snapshot" },
    { status: 202 }
  );
}

export async function POST(req: NextRequest) {
  return GET(req);
}

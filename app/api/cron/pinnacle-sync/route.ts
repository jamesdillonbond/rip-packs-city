import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { writeInvocationHeartbeat } from "@/lib/pipeline/heartbeat"

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
) as any;

export const dynamic = "force-dynamic";
// 60s (was 30) so a severe cron-rush slowdown of pinnacle_fmv_recalc_render_all
// (baseline ~2s, DB statement_timeout 120s) cannot trip the Vercel layer before
// Postgres finishes. See audit_20260608_pinnacle_render_all_statement_timeout.
export const maxDuration = 60;

const PIPELINE_NAME = "pinnacle-sync";

// Observability (PIN-SYNC-OBS): logs every run to pipeline_runs so a stall/crash
// is visible to detect_stalled_pipelines (it previously logged nothing — the
// PIN-FMV2 2.4-day freeze 2026-06-04..06 was invisible).
//
// PIN-SYNC-FLOWTY (2026-06-06): the editions + listings sync legs were RETIRED.
// Both called Flowty (api2.flowty.io, shut 2026-05-13) via lib/pinnacle/sync.ts
// and threw "Cannot read properties of undefined (reading 'traits')" on every
// residual listing, forcing ok=false (status:"partial") on every run. They are
// fully superseded: catalog -> pinnacle-catalog-backfill (studio-platform GQL),
// sales -> pinnacle-events-ingest (on-chain) + render_id stamping. This route is
// now purely the daily Pinnacle FMV refresh.
//
// PIN-SYNC-ONE-OWNER (2026-08-03): the duplicate Vercel cron entry
// ("/api/cron/pinnacle-sync", "0 6 * * *") was REMOVED from vercel.json. Vercel
// Cron can only ever send CRON_SECRET, and this route accepts ONLY Bearer
// INGEST_SECRET_TOKEN, so every 06:00 tick 401'd - it never once executed the
// body (pinnacle_fmv_recalc_render_all self-logs 'pinnacle-fmv-recalc' whenever
// it runs, and there is no such row at ~06:00 on any retained day, only the
// 10:07 cron-job.org tick and the 22:37 pg_cron backstop). Rather than teach the
// route CRON_SECRET - which would add a THIRD full-render recalc per day on a
// DB that is the binding constraint - the dead entry was dropped. Owners now:
// cron-job.org ~10:07 UTC daily (HTTP) + pg_cron jobid 200 'rpc-pinnacle-fmv-
// recalc-backstop' 37 22 * * * (DB-side). Do NOT re-add a Vercel entry.
async function logRun(args: {
  startedAtIso: string;
  ok: boolean;
  rowsWritten: number;
  error: string | null;
  extra: Record<string, unknown>;
}) {
  try {
    await supabaseAdmin.rpc("log_pipeline_run", {
      p_pipeline: PIPELINE_NAME,
      p_started_at: args.startedAtIso,
      p_rows_found: args.rowsWritten,
      p_rows_written: args.rowsWritten,
      p_rows_skipped: 0,
      p_ok: args.ok,
      p_error: args.error,
      p_collection_slug: "disney_pinnacle",
      p_cursor_before: null,
      p_cursor_after: null,
      p_extra: args.extra,
    });
  } catch {
    // best-effort observability — never let logging fail the run
  }
}

// The render-FMV recalc runs ~15s but can exceed cron-job.org's 30s HTTP limit
// under contention (it reported "Failed (timeout) 30s" while the server work still
// completed + logged ok=true). It returns no data the trigger needs and logs its
// own result to pipeline_runs, so it's a clean fire-and-forget: respond 202 at once
// (CRON-30S pattern) and run the recalc in after() within maxDuration.
async function runPinnacleSync(startedAtIso: string) {
  const startedAt = Date.now();
  const errors: string[] = [];

  try {
    // Legacy-FMV retirement (2026-06-08): the set-level pinnacle_fmv_snapshots table is
    // retired — every reader is on per-render pinnacle_catalog. This route rebuilds the
    // per-render FMV home pinnacle_catalog.fmv_* (PIN-FMV-REKEY).
    //
    // Flowty teardown (2026-06-08): pinnacle_refresh_editions_ask() is NO LONGER called
    // here. It sourced pinnacle_editions.ask_price from pinnacle_cached_listings — a
    // dead-Flowty cache frozen at 2026-05-27 — and overwrote the then-fresh on-chain ASK
    // that pinnacle-listings-reconcile wrote every ~15 min (ask_source='pinnacle_direct').
    //
    // ⚠ UPDATED 2026-08-21 — the sentence that used to end this comment ("the reconcile
    // cron is now the sole ASK writer") is NO LONGER TRUE, and a stale comment naming a
    // live writer is worse than no comment. ASK-unify retired reconcile on 2026-07-17;
    // its route was deleted 2026-08-21 after measuring zero runs in pipeline_runs_daily
    // (retained indefinitely) and no pg_cron job. So pinnacle_editions.ask/ask_price is
    // FROZEN — 328 rows, freshest ask_updated_at 2026-07-17T14:09Z, and deliberately
    // read by nothing (app/api/wallet/seed cut over the same day). The canonical ASK is
    // the render-grain pinnacle_catalog.floor_ask, rewritten daily by
    // pinnacle_catalog_set_floor_asks. The pinnacle_ask_stale_hours pager was retired
    // with the writer, so nothing pages on the frozen column either.
    //
    // This route still owns only the render-FMV recompute, which is independent of both.
    const fmvRecalcRender = await supabaseAdmin.rpc("pinnacle_fmv_recalc_render_all");
    if (fmvRecalcRender.error) errors.push(`pinnacle_fmv_recalc_render_all: ${fmvRecalcRender.error.message}`);

    const rowsWritten = Number(fmvRecalcRender.data?.renders_priced ?? 0);
    const ok = errors.length === 0;
    await logRun({
      startedAtIso,
      ok,
      rowsWritten,
      error: errors[0] ?? null,
      extra: {
        phase: "complete",
        fmv_recalc_render: fmvRecalcRender.data ?? null,
        duration_ms: Date.now() - startedAt,
        errors: errors.slice(0, 3),
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    errors.push(message);
    await logRun({
      startedAtIso,
      ok: false,
      rowsWritten: 0,
      error: message,
      extra: { phase: "complete", duration_ms: Date.now() - startedAt, errors: errors.slice(0, 3) },
    });
  }
}

export async function GET(request: NextRequest) {
  const auth = request.headers.get("authorization");
  if (auth !== `Bearer ${process.env.INGEST_SECRET_TOKEN}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const startedAtIso = new Date().toISOString();

  // PIN-SYNC-INVOKED (2026-08-03): synchronous invocation marker, written BEFORE
  // after() is scheduled. The route already logged to pipeline_runs, but ONLY from
  // inside after() - so when Vercel drops/freezes the deferred work, the run leaves
  // no row at all and detect_stalled_pipelines reports pinnacle-sync silent even
  // though the recalc ran (proved 2026-08-02: pinnacle_fmv_recalc_render_all logged
  // its own 'pinnacle-fmv-recalc' row at 10:07:13Z with 2,160 renders priced, while
  // 'pinnacle-sync' logged nothing - a false stall on a 1,560-min threshold).
  // With this marker the two states are distinguishable:
  //   marker only, no phase:"complete" row -> after() was dropped
  //   no marker at all                     -> route never reached (cron down / auth)
  // Logged ok:true so it cannot inflate v_pipeline_failure_rates.
  // ⚠ 2026-08-20: this marker used to be written under the pipeline's OWN name,
  // and that DEFEATED the alarm it was added to protect. `detect_stalled_pipelines()`
  // computes `max(started_at) FROM pipeline_runs WHERE pipeline = w.pipeline` with
  // NO phase filter, so a self-named marker refreshes `last_run` on every tick —
  // the arm can never fire, however many after() bodies die. Measured across the
  // ~72h retention window: allday-pack-listings had 212 markers against 208
  // completions (6 ticks started and never finished, every one invisible), and
  // pinnacle-sync and compute-laliga-pack-ev had markers ONLY, zero completions.
  // A monitor whose input set includes its own output. The marker now goes under
  // `<pipeline>-heartbeat` via lib/pipeline/heartbeat.ts, which keeps the three
  // states readable AND leaves the stall arm measuring real completions.
  await writeInvocationHeartbeat(
    { pipeline: PIPELINE_NAME, startedAtMs: Date.parse(startedAtIso) },
    supabaseAdmin,
  );

  // Fatal-catch: runPinnacleSync catches its own errors, but an uncaught throw
  // (or a rejection from logRun's own await chain) would otherwise write nothing
  // and make a genuine crash indistinguishable from a dropped after().
  after(() =>
    runPinnacleSync(startedAtIso).catch(async (err) => {
      const message = err instanceof Error ? err.message : String(err);
      console.log(`[${PIPELINE_NAME}] fatal:`, message);
      await logRun({
        startedAtIso,
        ok: false,
        rowsWritten: 0,
        error: message,
        extra: { phase: "complete", failed_at: "uncaught" },
      });
    })
  );

  return NextResponse.json({ status: "accepted" }, { status: 202 });
}

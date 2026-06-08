import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

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

export async function GET(request: NextRequest) {
  const auth = request.headers.get("authorization");
  if (auth !== `Bearer ${process.env.INGEST_SECRET_TOKEN}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const startedAt = Date.now();
  const startedAtIso = new Date(startedAt).toISOString();
  const errors: string[] = [];

  try {
    // Legacy-FMV retirement (2026-06-08): the set-level pinnacle_fmv_snapshots table is
    // retired — every reader is on per-render pinnacle_catalog. This route rebuilds the
    // per-render FMV home pinnacle_catalog.fmv_* (PIN-FMV-REKEY).
    //
    // Flowty teardown (2026-06-08): pinnacle_refresh_editions_ask() is NO LONGER called
    // here. It sourced pinnacle_editions.ask_price from pinnacle_cached_listings — a
    // dead-Flowty cache frozen at 2026-05-27 — and overwrote the genuinely-fresh on-chain
    // ASK that pinnacle-listings-reconcile writes every ~15 min (ask_source=
    // 'pinnacle_direct', from pinnacle_listing_events). The reconcile cron is now the sole
    // ASK writer; this route owns only the render-FMV recompute, which is independent.
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
        fmv_recalc_render: fmvRecalcRender.data ?? null,
        duration_ms: Date.now() - startedAt,
        errors: errors.slice(0, 3),
      },
    });

    return NextResponse.json({
      status: ok ? "ok" : "partial",
      fmv_recalc_render: fmvRecalcRender.data ?? 0,
      errors,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    errors.push(message);
    await logRun({
      startedAtIso,
      ok: false,
      rowsWritten: 0,
      error: message,
      extra: { duration_ms: Date.now() - startedAt, errors: errors.slice(0, 3) },
    });
    return NextResponse.json({ status: "error", errors }, { status: 500 });
  }
}

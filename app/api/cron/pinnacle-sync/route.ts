import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { syncPinnacleEditions, syncPinnacleListings } from "@/lib/pinnacle/sync";

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
) as any;

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const PIPELINE_NAME = "pinnacle-sync";

// Observability (PIN-SYNC-OBS): this route rebuilds Pinnacle FMV daily
// (pinnacle_fmv_recalc_all, replace-in-place) + syncs editions/listings, but
// historically logged NOTHING to pipeline_runs — so when both the external cron
// died AND pinnacle_fmv_recalc_all crashed (PIN-FMV2, 2026-06-04..06), the
// 2.4-day freeze was invisible to detect_stalled_pipelines. Now every run logs.
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
    const editionResult = await syncPinnacleEditions(supabaseAdmin);
    errors.push(...editionResult.errors);

    const listingResult = await syncPinnacleListings(supabaseAdmin);
    errors.push(...listingResult.errors);

    // Refresh FMV snapshots from the latest listings + sales. Matches the
    // inline behaviour of /api/pinnacle-listing-cache so the daily cron
    // keeps fmv_snapshots current without a separate trigger.
    const fmvFromListings = await supabaseAdmin.rpc("pinnacle_fmv_from_listings");
    if (fmvFromListings.error) errors.push(`pinnacle_fmv_from_listings: ${fmvFromListings.error.message}`);
    const fmvRecalcAll = await supabaseAdmin.rpc("pinnacle_fmv_recalc_all");
    if (fmvRecalcAll.error) errors.push(`pinnacle_fmv_recalc_all: ${fmvRecalcAll.error.message}`);

    // PIN-FMV-REKEY Phase A: keep the per-render FMV home (pinnacle_catalog.fmv_*)
    // fresh alongside the legacy set-level table during the reader-wave transition.
    // Additive — readers migrate to the render-keyed columns in waves; legacy stays
    // live until the reader grep hits zero. Logs its own 'pinnacle-fmv-recalc' run.
    const fmvRecalcRender = await supabaseAdmin.rpc("pinnacle_fmv_recalc_render_all");
    if (fmvRecalcRender.error) errors.push(`pinnacle_fmv_recalc_render_all: ${fmvRecalcRender.error.message}`);

    const rowsWritten = (editionResult.editions_upserted ?? 0) + (listingResult.listings_upserted ?? 0);
    const ok = errors.length === 0;
    await logRun({
      startedAtIso,
      ok,
      rowsWritten,
      error: errors[0] ?? null,
      extra: {
        editions_upserted: editionResult.editions_upserted,
        listings_upserted: listingResult.listings_upserted,
        fmv_from_listings: fmvFromListings.data ?? null,
        fmv_recalc_all: fmvRecalcAll.data ?? null,
        fmv_recalc_render: fmvRecalcRender.data ?? null,
        duration_ms: Date.now() - startedAt,
        errors: errors.slice(0, 3),
      },
    });

    return NextResponse.json({
      status: ok ? "ok" : "partial",
      editions_upserted: editionResult.editions_upserted,
      listings_upserted: listingResult.listings_upserted,
      fmv_from_listings: fmvFromListings.data ?? 0,
      fmv_recalc_all: fmvRecalcAll.data ?? 0,
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
    return NextResponse.json(
      { status: "error", editions_upserted: 0, listings_upserted: 0, errors },
      { status: 500 }
    );
  }
}

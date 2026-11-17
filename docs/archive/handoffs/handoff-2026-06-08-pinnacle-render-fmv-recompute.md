# Handoff 2026-06-08 — Pinnacle render-FMV recompute is timing out (batch it)

REVIEW-GATED (FMV pipeline) — drafted by Cowork, NOT shipped. The per-render pricing math stays untouched; this only changes WHICH renders are recomputed per tick (orchestration/throughput).

## Problem (live, growing)

`pinnacle-sync`'s `pinnacle_fmv_recalc_render_all()` was CANCELED (statement timeout) on the 2026-06-08 10:07Z tick. It's a row-by-row loop — `FOR r IN SELECT DISTINCT render_id FROM pinnacle_sales LOOP v := pinnacle_fmv_recalc_render(r.render_id); UPDATE pinnacle_catalog ... END LOOP` — over ~1,794+ renders, each a pricer call + UPDATE. The whole sweep no longer fits in one statement-timeout window (same class as the cross-collection cohort loop fixed today). Effect: `pinnacle_catalog.fmv_computed_at` is stuck at 2026-06-07 10:07Z (~29h stale and not advancing — every daily tick times out before committing). This also BLOCKS the legacy `pinnacle_fmv_snapshots` retirement (step 3) — that drop must stay blocked until render FMV refreshes cleanly.

The pricer `pinnacle_fmv_recalc_render(render_id)` is fine and FAST per render; the bottleneck is doing all ~1,794 sequentially in one transaction. Throughput lever, not a math bug.

## Fix — stalest-first batch function + a dedicated cron (recommended)

Add a batch variant that recomputes the N stalest renders per call (so over enough ticks every render refreshes, time-decay included), then point a small frequent cron at it. The loop body is copied VERBATIM from `_all` (same pricer call, same UPDATE/column mapping, same algo_version) — only the cursor gains ORDER BY fmv_computed_at + LIMIT, plus a statement_timeout and pipeline_runs logging.

CREATE OR REPLACE FUNCTION public.pinnacle_fmv_recalc_render_batch(p_limit int DEFAULT 300)
 RETURNS json LANGUAGE plpgsql
 SET search_path TO 'public','pg_temp' SET statement_timeout TO '120s'
AS $function$
DECLARE v_count int := 0; v_skipped int := 0; r record; v json; v_started timestamptz := clock_timestamp();
BEGIN
  FOR r IN
    SELECT s.render_id
    FROM (SELECT DISTINCT render_id FROM pinnacle_sales WHERE render_id IS NOT NULL) s
    LEFT JOIN pinnacle_catalog c ON c.render_id = s.render_id
    ORDER BY c.fmv_computed_at ASC NULLS FIRST
    LIMIT p_limit
  LOOP
    v := pinnacle_fmv_recalc_render(r.render_id);
    UPDATE public.pinnacle_catalog c
       SET fmv_usd = NULLIF((v->>'fmv_usd'),'')::numeric,
           fmv_wap_usd = NULLIF((v->>'wap_usd'),'')::numeric,
           fmv_confidence = (v->>'confidence')::public.fmv_confidence,
           fmv_sales_count_7d = (v->>'sales_count_7d')::int,
           fmv_sales_count_30d = (v->>'sales_count_30d')::int,
           fmv_days_since_sale = NULLIF((v->>'days_since_sale'),'')::int,
           fmv_liquidity_rating = (v->>'liquidity_rating')::int,
           fmv_computed_at = NOW(),
           fmv_algo_version = 'pinnacle-2.0.0-render'
     WHERE c.render_id = r.render_id;
    IF (v->>'fmv_usd') IS NULL THEN v_skipped := v_skipped + 1; ELSE v_count := v_count + 1; END IF;
  END LOOP;
  PERFORM log_pipeline_run('pinnacle-fmv-recalc-batch', v_started,
    v_count + v_skipped, v_count, v_skipped, true, NULL, 'disney_pinnacle', NULL, NULL,
    json_build_object('renders_priced', v_count, 'renders_no_data', v_skipped, 'batch', p_limit)::jsonb);
  RETURN json_build_object('renders_priced', v_count, 'renders_no_data', v_skipped, 'computed_at', NOW());
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.pinnacle_fmv_recalc_render_batch(int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pinnacle_fmv_recalc_render_batch(int) TO service_role, postgres;

Cadence: ~1,794 renders ÷ 300/tick ≈ 6 ticks for a full sweep. Run it often enough that the sweep period is well inside the FMV time-decay tolerance — e.g. a dedicated cron every ~2-3h (≈ 6 ticks ≈ full sweep in ~12-18h), OR fold a `pinnacle_fmv_recalc_render_batch(300)` call into the existing pinnacle-sync if its slot is frequent enough. Pick an empty comma-trio off the rush (rpc-cron-ops). Watchlist `pinnacle-fmv-recalc-batch` only after its first ok=true at the new slot.

Then repoint pinnacle-sync OFF `pinnacle_fmv_recalc_render_all()` (the timing-out full sweep) onto the batch path, OR keep `_all` only for manual/backfill use with a raised statement_timeout (it still won't fit a 30s cron, but is fine to run by hand server-side).

## Immediate stopgap (clear the 29h staleness now)

After the batch fn ships, run it back-to-back a handful of times (each ≤120s) until `pinnacle_catalog.fmv_computed_at` is all-current — that drains the stale backlog stalest-first without any single call timing out. Verify: `SELECT count(*), min(fmv_computed_at), max(fmv_computed_at) FROM pinnacle_catalog WHERE fmv_usd IS NOT NULL;` (min should advance to today). I did NOT do this from Cowork because it requires the new function (review-gated) — it's one paste + a few calls once you approve.

## Why this wasn't auto-shipped
`pinnacle_fmv_recalc_render` IS the FMV pricing engine (review-gated per the FMV-pipeline-patch-restraint rule). This handoff changes only orchestration (which renders, in what order, per tick) and copies the existing persist mapping verbatim — but anything in the FMV write path gets a human review + a live eyeball that displayed Pinnacle prices don't move. The dedicated `pinnacle-sync-tick-verify-jun8` task already flagged this tick as not-clean and owns the "legacy drop stays blocked" verdict.

VERIFY / GUARDRAILS: after ship, batch fn EXECUTE = service_role/postgres only (no anon/auth); a few runs clear the stale backlog; pinnacle_catalog.fmv_computed_at advances to today; only THEN is the legacy `pinnacle_fmv_snapshots` drop unblocked. Direct-to-main, no branches/PRs; ledger-log the migration. CC's file inspection wins over this doc.

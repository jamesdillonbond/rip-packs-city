-- audit_20261010_refresh_atlas_pack_ev_survives_a_wider_pool
-- anon-exec: unchanged (refresh_atlas_pack_ev) — CREATE OR REPLACE of an existing fn, same signature; ACL preserved.
--
-- 2026-10-10 (known-issues #65 follow-up). sync_topshot_pools_from_atlas (20261010163642..164143)
-- widened the Atlas-pool set this function sweeps from 57 dists to ~820, and its first manual run
-- aborted at row 14: "violates check constraint pack_ev_history_pack_ev_sane_range". Three latent
-- defects, each fatal to the WHOLE hourly sweep and each newly reachable:
--   1. pack_ev = gross - ask was unclamped; two live dists carry a $1,000,000 troll ask.
--      Now clamped to the CHECK range, as compute_pack_ev_per_edition_weighted clamps its own;
--      the +EV flag is still computed from the unclamped margin.
--   2. is_positive_ev was NULL with no ask; the live column is NOT NULL (13 ask-less dists).
--      Now COALESCE(..., false).
--   3. pack_listing_id (NOT NULL; pack_ev_latest's key) came from metadata->>'uuid', absent on
--      47 dists. Those are now counted ('unkeyed') and not swept.
-- And the handler now LOGS ok=false (it returned silently -- the pin's "recorded, not fixed").
-- The pin's fixture had none of prod's NOT NULL / CHECK constraints, which is how 2 and 3 were
-- pinned as properties; it mirrors them now. Body built from the pin (pin == live proven by md5).
--
-- REVERT: re-apply refresh_atlas_pack_ev from 20260920143959.

CREATE OR REPLACE FUNCTION public.refresh_atlas_pack_ev()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '120s'
AS $function$
DECLARE
  v_cid uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  r record;
  ev jsonb;
  v_gross numeric;
  v_typical numeric;
  v_written int := 0;
  v_unkeyed int := 0;
  v_now timestamptz := now();
BEGIN
  -- a dist with no listing uuid cannot be written (pack_listing_id is NOT NULL, and
  -- pack_ev_latest is keyed on it): counted, not swept, so it cannot abort the sweep
  SELECT count(DISTINCT p.dist_id) INTO v_unkeyed
    FROM pack_drop_pool p
    JOIN pack_distributions pd ON pd.collection_id = v_cid AND pd.dist_id = p.dist_id
   WHERE p.collection_id = v_cid AND p.pool_source = 'atlas' AND pd.metadata->>'uuid' IS NULL;

  FOR r IN
    SELECT DISTINCT p.dist_id,
           pd.metadata->>'uuid' AS listing_uuid,
           COALESCE(pd.title, pd.metadata->>'name') AS title,
           GREATEST(COALESCE((pd.metadata->>'number_of_pack_slots')::int, 1), 1) AS slots,
           pas.lowest_ask,
           pd.total_sealed,
           pd.depletion_pct
    FROM pack_drop_pool p
    JOIN pack_distributions pd ON pd.collection_id = v_cid AND pd.dist_id = p.dist_id
    LEFT JOIN pack_ask_state pas ON pas.collection_slug = 'nba-top-shot' AND pas.dist_id = p.dist_id
                                 AND pas.is_listed IS TRUE AND pas.lowest_ask > 0
    WHERE p.collection_id = v_cid AND p.pool_source = 'atlas'
      AND pd.metadata->>'uuid' IS NOT NULL
  LOOP
    ev := public.compute_pack_ev_per_edition_weighted(v_cid, r.dist_id, COALESCE(r.lowest_ask, 0), r.slots);
    IF (ev->>'ok')::boolean IS NOT TRUE THEN
      INSERT INTO pack_ev_history (pack_listing_id, collection_id, dist_id, pack_name, pack_price,
        primary_price, secondary_ask, price_source, primary_available, secondary_available,
        gross_ev, typical_ev, pack_ev, is_positive_ev, value_ratio, fmv_coverage_pct, edition_count, total_unopened, depletion_pct, snapshotted_at)
      VALUES (r.listing_uuid, v_cid, r.dist_id, r.title, COALESCE(r.lowest_ask,0),
        NULL, r.lowest_ask, CASE WHEN r.lowest_ask > 0 THEN 'secondary' ELSE 'none' END,
        false, r.lowest_ask > 0, 0, NULL, 0, false, NULL, NULL, 0, 0, 100, v_now);
      v_written := v_written + 1;
      CONTINUE;
    END IF;
    v_gross := (ev->>'gross_ev')::numeric;
    v_typical := (ev->>'typical_pull_ev')::numeric;
    INSERT INTO pack_ev_history (pack_listing_id, collection_id, dist_id, pack_name, pack_price,
      primary_price, secondary_ask, price_source, primary_available, secondary_available,
      gross_ev, typical_ev, pack_ev, is_positive_ev, value_ratio, fmv_coverage_pct, edition_count, total_unopened, depletion_pct, snapshotted_at)
    VALUES (
      r.listing_uuid, v_cid, r.dist_id, r.title, COALESCE(r.lowest_ask, 0),
      NULL, r.lowest_ask, CASE WHEN r.lowest_ask > 0 THEN 'secondary' ELSE 'none' END,
      false, r.lowest_ask > 0,
      v_gross, v_typical,
      -- clamped to the column's sane range (as compute_pack_ev_per_edition_weighted clamps
      -- its own): a troll ask ($1,000,000 on two live dists) is otherwise a CHECK violation
      -- that aborts the whole sweep. The flag is computed from the unclamped margin.
      GREATEST(LEAST(round(v_gross - COALESCE(r.lowest_ask, 0), 2), 1000000), -10000),
      -- no ask -> FALSE, never NULL: the live column is NOT NULL (a NULL aborted the sweep)
      COALESCE(r.lowest_ask > 0 AND (v_gross - r.lowest_ask) > 0, false),
      CASE WHEN r.lowest_ask > 0 THEN round(v_gross / r.lowest_ask, 3) ELSE NULL END,
      (ev->>'fmv_coverage_pct')::smallint, LEAST((ev->>'edition_count')::int, 32767), r.total_sealed, r.depletion_pct, v_now);
    v_written := v_written + 1;
  END LOOP;

  PERFORM public.log_pipeline_run('topshot-atlas-pack-ev', v_now, v_written + v_unkeyed, v_written, v_unkeyed, true, NULL,
    'nba-top-shot', NULL, NULL, jsonb_build_object('rows', v_written, 'unkeyed', v_unkeyed));
  RETURN jsonb_build_object('ok', true, 'written', v_written, 'unkeyed', v_unkeyed, 'finished_at', now());
EXCEPTION WHEN query_canceled OR OTHERS THEN
  -- a failed sweep LOGS (it used to return silently, leaving no pipeline_runs row); the
  -- rows it wrote roll back with it, so rows_written is 0
  PERFORM public.log_pipeline_run('topshot-atlas-pack-ev', v_now, v_written, 0, 0, false, left(SQLERRM, 300),
    'nba-top-shot', NULL, NULL, jsonb_build_object('rows', 0, 'reached', v_written));
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM, 'written', 0);
END;
$function$;

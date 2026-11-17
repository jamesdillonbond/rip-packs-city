-- audit_20260810_wmc_metadata_selfheal_fn_d8
--
-- Deep-audit register D8: wmc metadata denorm has NO self-heal. A wallet walk
-- inserts wmc rows then enriches player_name/tier/set_name/mint_count/team_name
-- from `editions`; when that post-pass enrichment fails it is only console.warn'd
-- (never logged) and skipCached blocks recovery on the next walk, so rows stay
-- nameless forever. The 56,898-row backlog was repaired 08-09 but WILL regenerate
-- (47,305 of 47,498 AllDay rows were created within 7 days). UFC had a separate
-- 4,556-row backlog never touched by that repair (found + healed 2026-08-10).
--
-- Fix: an OBSERVABLE self-heal wrapper around the existing pinned, idempotent,
-- COALESCE-fill-only backfill_wmc_metadata_from_editions(). It logs the healed
-- count to pipeline_runs each run (answering the "never logged" half of the
-- finding — if regeneration ever outruns the sweep, rows_written stays high and
-- it's visible). Scheduled daily via 20260810150521.
--
-- The register vetoed a `player_name IS NULL` PARTIAL INDEX (partial-index
-- predicates block HOT on the hot walk-write path). This uses NO new index — the
-- daily scan rides idx_wmc_collection_id / a bounded seq scan; the WRITE touches
-- only the handful of still-NULL rows.
--
-- Revert: DROP FUNCTION public.rpc_wmc_metadata_selfheal(uuid);

CREATE OR REPLACE FUNCTION public.rpc_wmc_metadata_selfheal(p_collection_id uuid DEFAULT NULL)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '180s'
AS $function$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_healed  int := 0;
  v_ok      boolean := true;
  v_err     text := NULL;
BEGIN
  BEGIN
    -- Global (NULL) or single-collection; COALESCE fill-only, never overwrites.
    v_healed := public.backfill_wmc_metadata_from_editions(NULL, p_collection_id);
  EXCEPTION WHEN OTHERS THEN
    v_ok  := false;
    v_err := SQLERRM;
  END;

  PERFORM public.log_pipeline_run(
    'wmc-metadata-selfheal',
    v_started,
    v_healed,   -- rows_found
    v_healed,   -- rows_written (rows healed this run)
    0,          -- rows_skipped
    v_ok,
    v_err,
    NULL,       -- collection_slug (global unless scoped)
    NULL, NULL, -- cursors
    jsonb_build_object(
      'scope', COALESCE(p_collection_id::text, 'all'),
      'elapsed_ms', round(extract(epoch FROM clock_timestamp() - v_started) * 1000)
    )
  );

  RETURN v_healed;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.rpc_wmc_metadata_selfheal(uuid) FROM PUBLIC, anon, authenticated;

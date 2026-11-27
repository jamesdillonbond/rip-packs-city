-- audit_20261127_topshot_unsold_parallel_comps_run_record_fix
--
-- 2026-11-27 (Claude Code cloud). Fix-up to 20261127213224: refresh_topshot_unsold_parallel_comps() wrote its 177
-- set/parallel medians but its pipeline_runs record never landed — duration_ms is a GENERATED column (428C9), the same
-- defect 20261127184251 fixed in the tier-comps twin this was modelled on, and the record handler swallowed it. Insert
-- without duration_ms, and return the record error in the result instead of discarding it.
--
-- anon-exec: unchanged (refresh_topshot_unsold_parallel_comps) — CREATE OR REPLACE of an existing signature keeps its live ACL (service_role only; verified anon=false 11-27).
--
-- REVERT: re-apply the function body from 20261127213224.

CREATE OR REPLACE FUNCTION public.refresh_topshot_unsold_parallel_comps()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_written int := 0;
  v_deleted int := 0;
  v_err text;
  v_rec_err text;
BEGIN
  BEGIN
    INSERT INTO public.topshot_unsold_parallel_comps (set_id, parallel, est_usd, n_editions, computed_at)
    SELECT e.set_id::text, split_part(e.external_id, '::', 2),
           round(percentile_cont(0.5) WITHIN GROUP (ORDER BY m.price_usd)::numeric, 2),
           count(DISTINCT e.id)::int, v_now
      FROM public.editions e
      JOIN public.sales_market m ON m.edition_id = e.id
     WHERE e.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
       AND e.external_id ~ '^[0-9]+:[0-9]+::[0-9]+$'
       AND e.set_id IS NOT NULL
       AND m.collection_id = e.collection_id
       AND m.price_usd > 0
       AND m.sold_at > now() - interval '365 days'
     GROUP BY 1, 2
    HAVING percentile_cont(0.5) WITHIN GROUP (ORDER BY m.price_usd) > 0
    ON CONFLICT (set_id, parallel) DO UPDATE
      SET est_usd = EXCLUDED.est_usd, n_editions = EXCLUDED.n_editions, computed_at = EXCLUDED.computed_at;
    GET DIAGNOSTICS v_written = ROW_COUNT;

    -- write first, then retire only what this run did not write
    IF v_written > 0 THEN
      DELETE FROM public.topshot_unsold_parallel_comps WHERE computed_at < v_now;
      GET DIAGNOSTICS v_deleted = ROW_COUNT;
    END IF;
  -- a statement_timeout kill (57014) is not in OTHERS; name it so the run record below still sees it. The tail is
  -- one bounded INSERT, and the error is re-raised after it.
  EXCEPTION WHEN query_canceled OR others THEN
    v_err := SQLERRM;
  END;

  BEGIN
    INSERT INTO public.pipeline_runs (pipeline, collection_slug, started_at, finished_at, rows_found, rows_written, ok, error, extra)
    VALUES ('topshot-unsold-parallel-comps', 'nba_top_shot', v_now, clock_timestamp(), v_written, v_written,
            v_err IS NULL AND v_written > 0, COALESCE(v_err, CASE WHEN v_written = 0 THEN 'no set/parallel rows computed' END),
            jsonb_build_object('deleted', v_deleted));
  -- when-others-timeout-blind: intentional — the run record must not fail the refresh it records; a failed record is
  -- still reported, in the returned jsonb, so a caller reading it can tell.
  EXCEPTION WHEN OTHERS THEN
    v_rec_err := SQLERRM;
  END;

  IF v_err IS NOT NULL THEN
    RAISE EXCEPTION 'refresh_topshot_unsold_parallel_comps: %', v_err;
  END IF;
  RETURN jsonb_build_object('ok', v_written > 0, 'written', v_written, 'deleted', v_deleted, 'run_record_error', v_rec_err);
END
$function$;
REVOKE ALL ON FUNCTION public.refresh_topshot_unsold_parallel_comps() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_topshot_unsold_parallel_comps() TO service_role;

SELECT public.refresh_topshot_unsold_parallel_comps();

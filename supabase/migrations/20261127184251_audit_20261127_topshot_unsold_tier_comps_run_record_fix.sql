-- 2026-11-27 (Claude Code cloud). Fix-up to 20261127184110: refresh_topshot_unsold_tier_comps() wrote its estimates but
-- its pipeline_runs record never landed — duration_ms is a GENERATED column (428C9 "cannot insert a non-DEFAULT value"),
-- and the record's own handler swallowed that, so the first run left no trace. Insert without duration_ms, and return
-- the record's error in the result instead of discarding it.
--
-- anon-exec: intentional — CREATE OR REPLACE of an existing signature keeps its live ACL (service_role only; 20261127184110) (refresh_topshot_unsold_tier_comps)
--
-- REVERT: re-apply the function body from 20261127184110.

CREATE OR REPLACE FUNCTION public.refresh_topshot_unsold_tier_comps()
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
    WITH s AS (
      SELECT e.id, e.tier::text AS tier, e.set_name, m.price_usd, m.sold_at
        FROM public.editions e
        JOIN public.sales_market m ON m.edition_id = e.id
       WHERE e.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
         AND e.tier IN ('LEGENDARY', 'ULTIMATE')
         AND m.collection_id = e.collection_id
         AND m.price_usd > 0
         AND m.sold_at > now() - interval '180 days'
    ), tf AS (
      SELECT DISTINCT ON (id) tier, price_usd FROM s ORDER BY id, sold_at
    ), comps AS (
      SELECT tier, ''::text AS set_name, percentile_cont(0.5) WITHIN GROUP (ORDER BY price_usd)::numeric AS est, count(*)::int AS n
        FROM tf GROUP BY tier
      UNION ALL
      SELECT tier, set_name, percentile_cont(0.5) WITHIN GROUP (ORDER BY price_usd)::numeric, count(DISTINCT id)::int
        FROM s WHERE set_name IS NOT NULL GROUP BY tier, set_name
    )
    INSERT INTO public.topshot_unsold_tier_comps (tier, set_name, est_usd, n_editions, computed_at)
    SELECT tier, set_name, round(est, 2), n, v_now FROM comps WHERE est > 0
    ON CONFLICT (tier, set_name) DO UPDATE
      SET est_usd = EXCLUDED.est_usd, n_editions = EXCLUDED.n_editions, computed_at = EXCLUDED.computed_at;
    GET DIAGNOSTICS v_written = ROW_COUNT;

    -- write first, then retire only what this run did not write
    IF v_written > 0 THEN
      DELETE FROM public.topshot_unsold_tier_comps WHERE computed_at < v_now;
      GET DIAGNOSTICS v_deleted = ROW_COUNT;
    END IF;
  -- a statement_timeout kill (57014) is not in OTHERS; name it so the run record below still sees it. The tail is
  -- one bounded INSERT, and the error is re-raised after it.
  EXCEPTION WHEN query_canceled OR others THEN
    v_err := SQLERRM;
  END;

  BEGIN
    INSERT INTO public.pipeline_runs (pipeline, collection_slug, started_at, finished_at, rows_found, rows_written, ok, error, extra)
    VALUES ('topshot-unsold-tier-comps', 'nba_top_shot', v_now, clock_timestamp(), v_written, v_written,
            v_err IS NULL AND v_written > 0, COALESCE(v_err, CASE WHEN v_written = 0 THEN 'no tier/set rows computed' END),
            jsonb_build_object('deleted', v_deleted));
  -- when-others-timeout-blind: intentional — the run record must not fail the refresh it records; a failed record is
  -- still reported, in the returned jsonb, so a caller reading it can tell.
  EXCEPTION WHEN OTHERS THEN
    v_rec_err := SQLERRM;
  END;

  IF v_err IS NOT NULL THEN
    RAISE EXCEPTION 'refresh_topshot_unsold_tier_comps: %', v_err;
  END IF;
  RETURN jsonb_build_object('ok', v_written > 0, 'written', v_written, 'deleted', v_deleted, 'run_record_error', v_rec_err);
END
$function$;
REVOKE ALL ON FUNCTION public.refresh_topshot_unsold_tier_comps() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_topshot_unsold_tier_comps() TO service_role;

SELECT public.refresh_topshot_unsold_tier_comps();
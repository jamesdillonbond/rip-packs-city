-- audit_20261128_insights_trophies_board_materialized
--
-- WHAT. The /insights/trophies board is read from a materialized copy of v_insights_trophies, refreshed hourly,
-- instead of recomputing all ~8,521 rows on every request.
--   1. mv_insights_trophies = SELECT * FROM v_insights_trophies (same columns, same order), unique on edition_id
--      (so REFRESH ... CONCURRENTLY never blocks a reader), plus a collection index for the filtered read.
--   2. refresh_insights_trophies() — the logged-refresh shape of refresh_topshot_first_mint_trophies()
--      (pipeline 'insights-trophies-mv'), on pg_cron `6 * * * *` (minute 6 carried one other job).
--   3. board_mv_refresh_watchlist gains the MV, so board_mv_refresh_max_stale_hours() / trust metric
--      board_mv_refresh_stale_hours (breach 8 h) watches it — it finds this job by the refresh_<name>( wrapper.
--   4. public_board_liveness_watchlist probes the MV; the v_insights_trophies row is deactivated (no user reads
--      the view any more — the probe on it measured a cost nobody paid).
--   5. get_insights_trophies(text[]) reads the MV, filtered by collection. Same signature, same SETOF
--      v_insights_trophies return, still SECURITY INVOKER; insights_trophies_for_candy_property() calls it,
--      so both readers move.
--
-- WHY. Measured 2026-11-27/28: the board probe read 8,449 ms (4:28 PM PT) and 9,823 ms (10:28 PM PT) against a
-- 7,000 ms budget, and one user got `[insights/trophies] read exceeded 8000ms` at 12:34 AM PT 11-28 (served
-- honestly as board-unavailable). EXPLAIN (ANALYZE, BUFFERS) 11-27 8:10 PM PT: 7,518 ms, 7,555 blocks read,
-- 7.0 s of it I/O wait — the per-edition latest-FMV lookup (8,518 loops over fmv_snapshots_2025/26/27) plus the
-- wallet_moments_cache 1-of-1 probe. Not an index problem (relallvisible 95–100 %); the cost is the loop count,
-- paid on every request. The page is ISR 1 h and the route s-maxage 3600, so an hourly copy adds no staleness
-- a reader can see that the cache did not already add.
--
-- EQUIVALENCE (measured before writing this, one statement = one snapshot, both directions):
--   get_insights_trophies(all 7 collections) vs v_insights_trophies WHERE collection = ANY(...):
--     8,521 = 8,521 rows, 0 / 0 rows in either EXCEPT.
--   same for ['nfl_all_day','candy_mlb']: 5,736 = 5,736, 0 / 0. edition_id duplicates in the view: 0.
-- The function differs from the view only by `e_1.collection = ANY(p_collections)` on the edition scan; every
-- other term (the ULTIMATE-collection set, the 1-of-1 probe, the latest FMV) is per-edition or estate-wide,
-- so filtering the full set is the same rows. The DO block below re-proves it against the MV before the swap.
--
-- ⚠ BASE ASSERTED: get_insights_trophies prosrc md5 2275b46e961753faf59d1a3af604d1f7 (live 2026-11-28 7:50 AM PT).
--
-- anon-exec: unchanged (get_insights_trophies) — CREATE OR REPLACE, same signature, SECURITY INVOKER; EXECUTE grants preserved.
--   ⚠ The MV is service_role-only (the precedent: mv_candy_holder_board / mv_topshot_pack_realized_ev are not anon-readable),
--   so an anon or authenticated REST call to this function now errors (permission denied on the MV) instead of returning rows.
--   Every in-app caller uses the service-role client (lib/insights/trophies-board.ts fetchTrophiesBoard → supabaseAdmin:
--   app/api/public/insights/trophies/route.ts, app/insights/trophies/page.tsx); none uses the anon key.
-- anon-exec: revoked (refresh_insights_trophies) — new writer; REVOKE FROM PUBLIC, anon, authenticated, GRANT to postgres below.
--
-- REVERT:
--   CREATE OR REPLACE get_insights_trophies from supabase/migrations/20261119093000_audit_20261119_trophies_board_filters_collections_before_the_wallet_probe.sql;
--   SELECT cron.unschedule('rpc-refresh-insights-trophies');
--   UPDATE public.public_board_liveness_watchlist SET is_active = (view_name = 'v_insights_trophies') WHERE view_name IN ('v_insights_trophies','mv_insights_trophies');
--   DELETE FROM public.board_mv_refresh_watchlist WHERE matview_name = 'mv_insights_trophies';
--   DROP FUNCTION public.refresh_insights_trophies(); DROP MATERIALIZED VIEW public.mv_insights_trophies;

SET LOCAL lock_timeout = '3s';

DO $$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.get_insights_trophies(text[])'::regprocedure)
       IS DISTINCT FROM '2275b46e961753faf59d1a3af604d1f7' THEN
    RAISE EXCEPTION 'get_insights_trophies changed since 20261119093000 — re-read it before applying';
  END IF;
END $$;

CREATE MATERIALIZED VIEW IF NOT EXISTS public.mv_insights_trophies AS
  SELECT * FROM public.v_insights_trophies;

CREATE UNIQUE INDEX IF NOT EXISTS mv_insights_trophies_edition_id_uidx ON public.mv_insights_trophies (edition_id);
CREATE INDEX IF NOT EXISTS mv_insights_trophies_collection_idx ON public.mv_insights_trophies (collection);

REVOKE ALL ON public.mv_insights_trophies FROM PUBLIC;
REVOKE ALL ON public.mv_insights_trophies FROM anon, authenticated;
GRANT SELECT ON public.mv_insights_trophies TO service_role;

-- Re-prove equivalence against the MV just built: the OLD function (still in place) vs the MV, same filter.
-- A difference here can only be a price written between the two statements, so allow a sliver, never a shape change.
CREATE TEMP TABLE _trophies_old ON COMMIT DROP AS
  SELECT edition_id, is_one_of_one, is_top_tier, is_ultimate
    FROM public.get_insights_trophies(array['nba_top_shot','nfl_all_day','laliga_golazos','ufc_strike','candy_mlb','panini_blockchain','disney_pinnacle']);

DO $$
DECLARE
  v_fn bigint; v_mv bigint; v_diff bigint;
BEGIN
  SELECT count(*) INTO v_fn FROM _trophies_old;
  SELECT count(*) INTO v_mv FROM public.mv_insights_trophies;
  SELECT count(*) INTO v_diff FROM (
    (SELECT * FROM _trophies_old EXCEPT SELECT edition_id, is_one_of_one, is_top_tier, is_ultimate FROM public.mv_insights_trophies)
    UNION ALL
    (SELECT edition_id, is_one_of_one, is_top_tier, is_ultimate FROM public.mv_insights_trophies EXCEPT SELECT * FROM _trophies_old)) x;
  IF v_mv = 0 OR abs(v_fn - v_mv) > 5 OR v_diff > 5 THEN
    RAISE EXCEPTION 'mv_insights_trophies does not match get_insights_trophies: fn % rows, mv % rows, % edition/flag rows differ', v_fn, v_mv, v_diff;
  END IF;
  RAISE NOTICE 'equivalence: fn % rows, mv % rows, % differ', v_fn, v_mv, v_diff;
END $$;

CREATE OR REPLACE FUNCTION public.refresh_insights_trophies()
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_rows    integer;
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_insights_trophies;
  SELECT count(*) INTO v_rows FROM public.mv_insights_trophies;
  PERFORM public.log_pipeline_run(
    p_pipeline     := 'insights-trophies-mv',
    p_started_at   := v_started,
    p_rows_found   := v_rows,
    p_rows_written := v_rows,
    p_ok           := true,
    p_extra        := jsonb_build_object(
      'refresh_ms', round(extract(epoch FROM clock_timestamp() - v_started) * 1000)::int,
      'mv', 'mv_insights_trophies')
  );
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.refresh_insights_trophies() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_insights_trophies() TO postgres;

CREATE OR REPLACE FUNCTION public.get_insights_trophies(p_collections text[])
 RETURNS SETOF v_insights_trophies
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  -- 2026-11-28: read the hourly materialized copy (mv_insights_trophies, refresh_insights_trophies on pg_cron
  -- `6 * * * *`) instead of recomputing every trophy's latest FMV per request. Same rows: the old body differed
  -- from v_insights_trophies only by this collection filter (proved 0/0 EXCEPT both ways, 20261128160000).
  SELECT m.* FROM public.mv_insights_trophies m WHERE m.collection = ANY (p_collections);
$function$;

INSERT INTO public.board_mv_refresh_watchlist (matview_name, max_stale_hours, is_active, note, watchlisted_at)
VALUES ('mv_insights_trophies', 8, true,
        '2026-11-28: /insights/trophies board (get_insights_trophies + insights_trophies_for_candy_property). Hourly refresh_insights_trophies() on pg_cron.',
        now())
ON CONFLICT DO NOTHING;

INSERT INTO public.public_board_liveness_watchlist (view_name, min_rows, max_ms, is_active, note)
SELECT 'mv_insights_trophies', w.min_rows, w.max_ms, true,
       '2026-11-28: the trophies board reads this MV; the view row is retired (no user reads the view).'
  FROM public.public_board_liveness_watchlist w
 WHERE w.view_name = 'v_insights_trophies'
   AND NOT EXISTS (SELECT 1 FROM public.public_board_liveness_watchlist x WHERE x.view_name = 'mv_insights_trophies');

UPDATE public.public_board_liveness_watchlist
   SET is_active = false,
       note = coalesce(note, '') || ' | retired 2026-11-28: the board reads mv_insights_trophies (20261128153925).'
 WHERE view_name = 'v_insights_trophies';

SELECT cron.schedule('rpc-refresh-insights-trophies', '6 * * * *', 'SELECT public.refresh_insights_trophies()');

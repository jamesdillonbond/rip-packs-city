-- audit_20261116_atlas_pool_sync_trusts_a_reconfirmed_edition_list
--
-- 2026-11-16 ~11:00 PM PT (Claude Code cloud, autonomous pass; Trevor: "work autonomously … fix any issues").
-- sync_topshot_pools_from_atlas fills a pool only from an Atlas edition list FETCHED in the last 7 days.
-- But topshot_pack_supply_tick re-reads an UNCHANGED drop's summary every 40 h and carries its reconciled
-- pass forward without re-fetching the pages, so a quiet drop's list ages past 7 days while still being
-- proven current. Measured 11-16 ~10:50 PM PT: 647 Top Shot dists with an Atlas list and no pool, 626 of
-- them blocked by that gate alone, 11 of those LISTED on the secondary market and showing no EV (WNBA Base
-- Set Release 1 / 5, Chasing Run It Back: Origins, Two Moment Common Pack, Cleveland Cavaliers Pack
-- February, 4 WNBA Player's Choice / reward packs, a 76ers First Round pack); also the two reward packs
-- first seen today (6438, 7293), whose "new dist" fill could not fire for the same reason.
-- Fix: the 7-day gate reads the newer of the fetch time and the summary time WHEN that summary's pass is
-- the list's pass, finished, and reconciled (edition_remaining_sum = remaining_total). The 'refresh' test
-- keeps the fetch time, so an unchanged Atlas pool is not rewritten every 40 h. All other gates unchanged.
-- Body = the 20261113195652 body verbatim (live prosrc md5 55997f014d8ca5a8047ff832ca270216 verified equal
-- to the pin immediately before) plus the lp0/lp hunk marked 2026-11-16. Expected live md5 after apply:
-- 677c29cc75ed54cd6f1490dd77eb26b1.
-- anon-exec: unchanged (sync_topshot_pools_from_atlas) — CREATE OR REPLACE of an existing fn; ACL preserved, verified has_function_privilege anon=false, authenticated=false.
-- REVERT: re-apply the function block of
--   supabase/migrations/20261113195652_audit_20261113_topshot_atlas_pool_fills_new_dists_without_an_ask.sql verbatim.
--   Pools it filled stay (same writer, same gates); to remove them:
--   DELETE FROM pack_drop_pool WHERE collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd' AND pool_source = 'atlas'
--     AND dist_id IN (<the dists listed in the ledger entry>);

DO $guard$
BEGIN
  IF (SELECT md5(trim(regexp_replace(prosrc, '\s+', ' ', 'g'))) FROM pg_proc
       WHERE oid = 'public.sync_topshot_pools_from_atlas(integer)'::regprocedure) <> '55997f014d8ca5a8047ff832ca270216' THEN
    RAISE EXCEPTION 'live sync_topshot_pools_from_atlas is not the 20261113195652 body this migration was written against; re-read it';
  END IF;
END
$guard$;

CREATE OR REPLACE FUNCTION public.sync_topshot_pools_from_atlas(p_limit integer DEFAULT 400)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '110s'
AS $function$
DECLARE
  v_started  timestamptz := clock_timestamp();
  v_cid      constant uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_cands    int := 0;
  v_filled   int := 0;
  v_upgraded int := 0;
  v_skipped  int := 0;
  v_rows     int := 0;
  v_zeroed   int := 0;
  v_err      text;
BEGIN
  BEGIN
    -- ONE statement (no temp tables): the write and the zeroing touch disjoint rows by construction
    WITH sub AS (
      -- parallel name -> subedition id (Rippled -> 4, Vortex -> 3, ...)
      SELECT lower(subedition_name) AS nm, min(subedition_id) AS sid
        FROM public.v_topshot_parallel_premiums
       WHERE subedition_name IS NOT NULL AND subedition_id IS NOT NULL
       GROUP BY 1
    ), pool AS (
      SELECT dist_id, count(*) FILTER (WHERE drop_weight > 0) AS n_live, bool_and(pool_source = 'gql') AS all_gql,
             bool_and(pool_source = 'atlas') AS all_atlas, max(last_refreshed_at) AS refreshed
        FROM public.pack_drop_pool WHERE collection_id = v_cid GROUP BY dist_id
    ), lp0 AS (
      SELECT dist_id, max(pass) AS p, max(fetched_at) AS f FROM public.topshot_atlas_dist_editions GROUP BY dist_id
    ), lp AS (
      -- 2026-11-16: an edition list is CURRENT, not only recently fetched, when a later summary
      -- carried that same reconciled pass forward (topshot_pack_supply_tick re-reads an unchanged
      -- drop's summary every 40 h without re-fetching its pages). 11 listed packs (WNBA Base Set
      -- R1/R5, Run It Back: Origins, Two Moment Common Pack, ...) had no pool because their pages
      -- were fetched > 7 days ago. The 7-day gate reads `fresh`; the 'refresh' test keeps `f`, so
      -- an unchanged Atlas pool is not rewritten every 40 h.
      SELECT lp0.dist_id, lp0.p, lp0.f,
             CASE WHEN t.editions_pass = lp0.p AND t.editions_done_at IS NOT NULL
                       AND t.edition_remaining_sum IS NOT DISTINCT FROM t.remaining_total
                  THEN greatest(lp0.f, t.summary_fetched_at) ELSE lp0.f END AS fresh
        FROM lp0 LEFT JOIN public.topshot_atlas_dists t ON t.dist_id = lp0.dist_id
    ), cand AS (
      -- a catalogued dist with a fresh Atlas edition list and EITHER no pool at all and a live
      -- secondary ask or a first sighting in the last 7 days ('fill'), OR a pool written only by the GraphQL lane, dormant since
      -- 2026-08-28 and truncated at its 40-row page cap on 433 of 767 dists ('upgrade'), OR an
      -- Atlas pool whose edition list has been re-fetched since it was written ('refresh')
      SELECT lp.dist_id, lp.p,
             CASE WHEN pool.dist_id IS NULL THEN 'fill' WHEN pool.all_gql THEN 'upgrade' ELSE 'refresh' END AS kind,
             CASE WHEN pool.all_gql THEN pool.n_live ELSE 0 END AS prior_n
        FROM lp
        JOIN public.pack_distributions pd ON pd.collection_id = v_cid AND pd.dist_id = lp.dist_id
        LEFT JOIN pool ON pool.dist_id = lp.dist_id
       WHERE lp.fresh > now() - interval '7 days'
         AND ((pool.dist_id IS NULL
               AND (EXISTS (SELECT 1 FROM public.pack_ask_state pas
                             WHERE pas.collection_slug = 'nba-top-shot' AND pas.dist_id = lp.dist_id
                               AND pas.is_listed IS TRUE AND pas.lowest_ask > 0)
                    -- 2026-11-13: a NEW dist (on primary sale, nothing listed yet) fills too, so its
                    -- EV exists while it is on sale; topshot_atlas_seed_new_dists feeds its editions
                    OR pd.first_seen_at > now() - interval '7 days'))
              OR pool.all_gql
              OR (pool.all_atlas AND lp.f > pool.refreshed))
       ORDER BY (pool.dist_id IS NULL) DESC, coalesce(pool.all_gql, false) DESC, lp.f DESC, lp.dist_id
       LIMIT greatest(coalesce(p_limit, 400), 1)
    ), arows AS (
      -- the latest Atlas pass of each candidate, mapped to our editions (base, or base::<subedition>)
      SELECT c.dist_id, c.kind, c.prior_n, e.id AS edition_id, e.external_id AS ext,
             greatest(coalesce(a.remaining_count, 0), 0)::numeric AS rem,
             greatest(coalesce(a.original_count, 0), 0)::numeric AS orig
        FROM cand c
        JOIN public.topshot_atlas_dist_editions a ON a.dist_id = c.dist_id AND a.pass = c.p
        LEFT JOIN sub s ON s.nm = lower(a.parallel)
        LEFT JOIN public.editions e ON e.collection_id = v_cid
             AND e.external_id = CASE WHEN a.parallel = 'Standard' THEN a.set_id || ':' || a.play_id
                                      WHEN s.sid IS NOT NULL THEN a.set_id || ':' || a.play_id || '::' || s.sid END
    ), ok AS (
      -- gates: <= 5 % of the ORIGINAL pool unmapped, something left to draw, and at least as many
      -- editions as the pool it replaces still had DRAWABLE (weight > 0; Atlas lists only editions
      -- with remaining > 0, so a pool's drawn-out rows are not a shortfall). Anything else keeps
      -- what it has.
      SELECT dist_id, kind, sum(rem) FILTER (WHERE edition_id IS NOT NULL) AS rem_mapped
        FROM arows
       GROUP BY dist_id, kind, prior_n
      HAVING coalesce(sum(orig) FILTER (WHERE edition_id IS NULL), 0) <= 0.05 * nullif(sum(orig), 0)
         AND coalesce(sum(rem) FILTER (WHERE edition_id IS NOT NULL), 0) > 0
         AND count(DISTINCT edition_id) >= prior_n
    ), w AS (
      -- drop_weight = this edition's share of what is LEFT to draw (what a sealed pack holds
      -- today); orig_drop_weight = the original count, as the 07-17 Atlas writer stored it
      SELECT r.dist_id, r.edition_id, min(r.ext) AS ext, sum(r.rem) / o.rem_mapped AS wt, sum(r.orig) AS orig
        FROM arows r
        JOIN ok o ON o.dist_id = r.dist_id
       WHERE r.edition_id IS NOT NULL
       GROUP BY r.dist_id, r.edition_id, o.rem_mapped
    ), ins AS (
      INSERT INTO public.pack_drop_pool
             (collection_id, dist_id, edition_id, edition_flow_id, drop_weight, orig_drop_weight, slot_name, pool_source, last_refreshed_at)
      SELECT v_cid, w.dist_id, w.edition_id, w.ext, w.wt, w.orig, 'default', 'atlas', now() FROM w
      ON CONFLICT (collection_id, dist_id, edition_id, slot_name) DO UPDATE
         SET drop_weight = EXCLUDED.drop_weight,
             orig_drop_weight = EXCLUDED.orig_drop_weight,
             edition_flow_id = EXCLUDED.edition_flow_id,
             pool_source = 'atlas',
             last_refreshed_at = EXCLUDED.last_refreshed_at
      RETURNING 1
    ), upd AS (
      -- a re-written dist's rows that this pass of Atlas does not list are editions with nothing
      -- left to draw (Atlas lists only remaining > 0): they keep their row and their original
      -- count but carry no weight (never deleted; the dist is uniformly 'atlas' afterwards)
      UPDATE public.pack_drop_pool p
         SET drop_weight = 0, pool_source = 'atlas', last_refreshed_at = now()
        FROM ok o
       WHERE p.collection_id = v_cid AND p.dist_id = o.dist_id
         AND NOT EXISTS (SELECT 1 FROM w WHERE w.dist_id = p.dist_id AND w.edition_id = p.edition_id)
         AND (p.drop_weight <> 0 OR p.pool_source <> 'atlas')
      RETURNING 1
    )
    SELECT (SELECT count(*) FROM cand),
           (SELECT count(*) FROM ok WHERE kind = 'fill'),
           (SELECT count(*) FROM ok WHERE kind <> 'fill'),
           (SELECT count(*) FROM ins),
           (SELECT count(*) FROM upd)
      INTO v_cands, v_filled, v_upgraded, v_rows, v_zeroed;
    v_skipped := v_cands - v_filled - v_upgraded;
  EXCEPTION WHEN query_canceled OR OTHERS THEN
    v_err := left(SQLERRM, 300);
    v_filled := 0; v_upgraded := 0; v_rows := 0; v_zeroed := 0;
  END;

  PERFORM public.log_pipeline_run(
    'topshot-pool-from-atlas', v_started, v_cands, v_rows, v_skipped,
    v_err IS NULL, v_err, 'nba_top_shot', NULL, NULL,
    jsonb_build_object('candidates', v_cands, 'filled', v_filled, 'rewritten', v_upgraded, 'skipped', v_skipped,
                       'rows_written', v_rows, 'rows_zeroed', v_zeroed, 'via', 'pg_cron',
                       'duration_ms', (extract(epoch FROM clock_timestamp() - v_started) * 1000)::int));

  RETURN jsonb_build_object('ok', v_err IS NULL, 'candidates', v_cands, 'filled', v_filled, 'rewritten', v_upgraded,
                            'skipped', v_skipped, 'rows_written', v_rows, 'rows_zeroed', v_zeroed, 'error', v_err);
END
$function$;

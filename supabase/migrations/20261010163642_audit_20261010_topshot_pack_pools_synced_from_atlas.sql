-- audit_20261010_topshot_pack_pools_synced_from_atlas
-- anon-exec: revoked (sync_topshot_pools_from_atlas) — new SECDEF writer; REVOKE FROM PUBLIC, anon, authenticated below, GRANT to postgres + service_role.
--
-- 2026-10-10 (known-issues #65). Top Shot pack EV is produced hourly by refresh_atlas_pack_ev()
-- for every dist whose pack_drop_pool rows are pool_source='atlas' -- and only 57 dists had one
-- (written once, 2026-07-17, by the retired upsert_topshot_atlas_pool). The GraphQL pool writer
-- (compute-topshot-pack-ev) has had no schedule since 2026-08-28; its 767 pools are frozen, 433
-- of them truncated at exactly 40 rows (its page cap), and they get no EV at all: Top Shot dists
-- with an EV row fell from ~835/week (August) to 152/week. Meanwhile the Atlas lane re-fetches
-- every dist's full edition list (topshot_atlas_dist_editions: original + remaining per edition)
-- and nothing reads it into the pool.
--
-- WHAT. sync_topshot_pools_from_atlas(p_limit) writes the latest Atlas pass of each candidate
-- dist into pack_drop_pool as pool_source='atlas' (drop_weight = share of what is LEFT to draw,
-- orig_drop_weight = original count, the shape the 07-17 writer used and
-- compute_pack_ev_per_edition_weighted reads). Candidates: no pool + a live secondary ask
-- ('fill'), an all-GraphQL pool ('upgrade'), an Atlas pool re-fetched since it was written
-- ('refresh'). Gates: <= 5 % of the original pool unmapped to our editions, something left to
-- draw, and at least as many editions as the pool it replaces. Rows Atlas no longer lists are
-- zeroed, never deleted. Scheduled hourly at :17, ahead of rpc-atlas-pack-ev at :25.
--
-- REVERT: SELECT cron.unschedule('rpc-topshot-pool-from-atlas');
--   DROP FUNCTION public.sync_topshot_pools_from_atlas(integer);
--   (the pool rows it wrote stay; the GraphQL rows it zeroed are re-written by
--   compute-topshot-pack-ev if that lane is ever revived)

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
      SELECT dist_id, count(*) AS n, bool_and(pool_source = 'gql') AS all_gql,
             bool_and(pool_source = 'atlas') AS all_atlas, max(last_refreshed_at) AS refreshed
        FROM public.pack_drop_pool WHERE collection_id = v_cid GROUP BY dist_id
    ), lp AS (
      SELECT dist_id, max(pass) AS p, max(fetched_at) AS f FROM public.topshot_atlas_dist_editions GROUP BY dist_id
    ), cand AS (
      -- a catalogued dist with a fresh Atlas edition list and EITHER no pool at all and a live
      -- secondary ask ('fill'), OR a pool written only by the GraphQL lane, dormant since
      -- 2026-08-28 and truncated at its 40-row page cap on 433 of 767 dists ('upgrade'), OR an
      -- Atlas pool whose edition list has been re-fetched since it was written ('refresh')
      SELECT lp.dist_id, lp.p,
             CASE WHEN pool.dist_id IS NULL THEN 'fill' WHEN pool.all_gql THEN 'upgrade' ELSE 'refresh' END AS kind,
             CASE WHEN pool.all_gql THEN pool.n ELSE 0 END AS prior_n
        FROM lp
        JOIN public.pack_distributions pd ON pd.collection_id = v_cid AND pd.dist_id = lp.dist_id
        LEFT JOIN pool ON pool.dist_id = lp.dist_id
       WHERE lp.f > now() - interval '7 days'
         AND ((pool.dist_id IS NULL
               AND EXISTS (SELECT 1 FROM public.pack_ask_state pas
                            WHERE pas.collection_slug = 'nba-top-shot' AND pas.dist_id = lp.dist_id
                              AND pas.is_listed IS TRUE AND pas.lowest_ask > 0))
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
      -- editions as the pool it replaces. Anything else keeps what it has.
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
      -- a re-written dist's rows that this pass of Atlas does not list keep their row but carry
      -- no weight (never deleted; the dist is uniformly 'atlas' afterwards)
      UPDATE public.pack_drop_pool p
         SET drop_weight = 0, orig_drop_weight = 0, pool_source = 'atlas', last_refreshed_at = now()
        FROM ok o
       WHERE p.collection_id = v_cid AND p.dist_id = o.dist_id
         AND NOT EXISTS (SELECT 1 FROM w WHERE w.dist_id = p.dist_id AND w.edition_id = p.edition_id)
         AND (p.drop_weight <> 0 OR coalesce(p.orig_drop_weight, 0) <> 0 OR p.pool_source <> 'atlas')
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

REVOKE EXECUTE ON FUNCTION public.sync_topshot_pools_from_atlas(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_topshot_pools_from_atlas(integer) TO postgres, service_role;
SELECT cron.schedule('rpc-topshot-pool-from-atlas', '17 * * * *', 'SELECT public.sync_topshot_pools_from_atlas(400);');

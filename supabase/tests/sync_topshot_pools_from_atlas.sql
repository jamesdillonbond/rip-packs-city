-- DB invariant: public.sync_topshot_pools_from_atlas — writes the latest Atlas edition list of a
-- Top Shot dist into pack_drop_pool (pool_source='atlas'), the input refresh_atlas_pack_ev reads
-- (known-issues #65: 767 frozen GraphQL pools, 433 truncated at 40 rows, 57 Atlas pools).
-- Claims:
--   1. an unpooled dist with a live ask is filled: drop_weight = remaining share (sums to 1),
--      orig_drop_weight = original count, a parallel maps to <set>:<play>::<subedition>;
--      an unpooled dist with NO live ask is left alone;
--   2. an all-GraphQL pool is upgraded: every row becomes 'atlas', a GraphQL row Atlas does not
--      list (nothing left to draw) gets drop_weight 0 and is KEPT with its original count;
--   3. a dist with > 5 % of its original pool unmapped, or nothing left to draw, or fewer editions
--      than the pool it would replace still had drawable (weight > 0), keeps what it has;
--   4. a re-run with no newer Atlas pass writes nothing; a newer pass re-weights the Atlas pool;
--   5. a failure is caught, logged ok=false, and the function still returns.
--
-- The function DDL below is VERBATIM from the committed migration
-- (supabase/migrations/20261010164143_audit_20261010_topshot_atlas_pool_sync_compares_drawable_editions.sql).
-- __tests__/db-invariants-drift-guard.test.ts fails CI on drift.

BEGIN;

CREATE TABLE public.pack_drop_pool (collection_id uuid, dist_id text, edition_id uuid, edition_flow_id text,
  drop_weight numeric DEFAULT 1, slot_name text, pool_source text DEFAULT 'gql', last_refreshed_at timestamptz DEFAULT now(),
  orig_drop_weight numeric, PRIMARY KEY (collection_id, dist_id, edition_id, slot_name));
CREATE TABLE public.pack_distributions (collection_id uuid, dist_id text);
CREATE TABLE public.pack_ask_state (collection_slug text, dist_id text, is_listed boolean, lowest_ask numeric);
CREATE TABLE public.topshot_atlas_dist_editions (dist_id text, atlas_edition_id text, pass bigint, set_id int, play_id int,
  parallel text, tier text, original_count bigint, remaining_count bigint, hidden_at_fetch bigint, fetched_at timestamptz);
CREATE TABLE public.editions (id uuid PRIMARY KEY, collection_id uuid, external_id text);
CREATE TABLE public.v_topshot_parallel_premiums (subedition_name text, subedition_id int);
CREATE TABLE public._runs (pipeline text, ok boolean, err text, extra jsonb);
CREATE FUNCTION public.log_pipeline_run(text, timestamptz, integer, integer, integer, boolean, text, text, text, text, jsonb)
  RETURNS void LANGUAGE sql AS $$ INSERT INTO public._runs VALUES ($1, $6, $7, $11) $$;

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
    ), lp AS (
      SELECT dist_id, max(pass) AS p, max(fetched_at) AS f FROM public.topshot_atlas_dist_editions GROUP BY dist_id
    ), cand AS (
      -- a catalogued dist with a fresh Atlas edition list and EITHER no pool at all and a live
      -- secondary ask ('fill'), OR a pool written only by the GraphQL lane, dormant since
      -- 2026-08-28 and truncated at its 40-row page cap on 433 of 767 dists ('upgrade'), OR an
      -- Atlas pool whose edition list has been re-fetched since it was written ('refresh')
      SELECT lp.dist_id, lp.p,
             CASE WHEN pool.dist_id IS NULL THEN 'fill' WHEN pool.all_gql THEN 'upgrade' ELSE 'refresh' END AS kind,
             CASE WHEN pool.all_gql THEN pool.n_live ELSE 0 END AS prior_n
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

-- fixtures. TS = 95f28a17-…; editions e1..e9
INSERT INTO public.v_topshot_parallel_premiums VALUES ('Rippled', 4), ('Vortex', 3);
INSERT INTO public.editions VALUES
  ('00000000-0000-0000-0000-0000000000e1', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '10:1'),
  ('00000000-0000-0000-0000-0000000000e2', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '10:2'),
  ('00000000-0000-0000-0000-0000000000e3', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '10:1::4'),
  ('00000000-0000-0000-0000-0000000000e4', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '20:1'),
  ('00000000-0000-0000-0000-0000000000e5', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '20:2'),
  ('00000000-0000-0000-0000-0000000000e6', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '20:9');
INSERT INTO public.pack_distributions SELECT '95f28a17-224a-4025-96ad-adf8a4c63bfd', d
  FROM unnest(ARRAY['D_FILL','D_NOASK','D_UP','D_UNMAPPED','D_EMPTY','D_SHRINK']) d;
INSERT INTO public.pack_ask_state SELECT 'nba-top-shot', d, true, 10
  FROM unnest(ARRAY['D_FILL','D_UNMAPPED','D_EMPTY']) d;
-- D_FILL: 3 editions incl. a Rippled parallel; remaining 6/3/1
INSERT INTO public.topshot_atlas_dist_editions VALUES
  ('D_FILL','a1',1,10,1,'Standard','COMMON',60,6,0, now() - interval '1 hour'),
  ('D_FILL','a2',1,10,2,'Standard','COMMON',30,3,0, now() - interval '1 hour'),
  ('D_FILL','a3',1,10,1,'Rippled','RARE',10,1,0, now() - interval '1 hour'),
  ('D_NOASK','a1',1,10,1,'Standard','COMMON',60,6,0, now() - interval '1 hour'),
-- D_UP: GraphQL pool lists e4, e6; Atlas lists e4, e5 (and not e6)
  ('D_UP','b1',1,20,1,'Standard','COMMON',50,5,0, now() - interval '1 hour'),
  ('D_UP','b2',1,20,2,'Standard','COMMON',50,15,0, now() - interval '1 hour'),
-- D_UNMAPPED: 10 % of the original pool is an unmapped parallel
  ('D_UNMAPPED','c1',1,10,1,'Standard','COMMON',90,9,0, now() - interval '1 hour'),
  ('D_UNMAPPED','c2',1,10,1,'Animated','RARE',10,1,0, now() - interval '1 hour'),
-- D_EMPTY: nothing left
  ('D_EMPTY','d1',1,10,2,'Standard','COMMON',90,0,0, now() - interval '1 hour'),
-- D_SHRINK: GraphQL pool has 2 editions, Atlas lists 1
  ('D_SHRINK','f1',1,20,1,'Standard','COMMON',90,9,0, now() - interval '1 hour');
INSERT INTO public.pack_drop_pool VALUES
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd','D_UP','00000000-0000-0000-0000-0000000000e4','20:1',0.5,'default','gql','2026-08-28',50),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd','D_UP','00000000-0000-0000-0000-0000000000e6','20:9',0.5,'default','gql','2026-08-28',50),
  -- a drawn-out GraphQL row: weight 0, not a shortfall when Atlas does not list it
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd','D_UP','00000000-0000-0000-0000-0000000000e1','10:1',0,'default','gql','2026-08-28',40),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd','D_SHRINK','00000000-0000-0000-0000-0000000000e4','20:1',0.5,'default','gql','2026-08-28',50),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd','D_SHRINK','00000000-0000-0000-0000-0000000000e5','20:2',0.5,'default','gql','2026-08-28',50);

SELECT _assert_eq((public.sync_topshot_pools_from_atlas(400)->>'ok'), 'true', 'run 1 ok');

-- claim 1
SELECT _assert_eq((SELECT round(sum(drop_weight), 6)::text FROM pack_drop_pool WHERE dist_id = 'D_FILL'), '1.000000', 'c1 fill weights sum to 1');
SELECT _assert_eq((SELECT round(drop_weight, 2)::text FROM pack_drop_pool WHERE dist_id = 'D_FILL' AND edition_flow_id = '10:1'), '0.60', 'c1 remaining share');
SELECT _assert_eq((SELECT orig_drop_weight::text FROM pack_drop_pool WHERE dist_id = 'D_FILL' AND edition_flow_id = '10:1::4'), '10', 'c1 parallel mapped with orig count');
SELECT _assert_eq((SELECT string_agg(DISTINCT pool_source, ',') FROM pack_drop_pool WHERE dist_id = 'D_FILL'), 'atlas', 'c1 source atlas');
SELECT _assert_eq((SELECT count(*)::text FROM pack_drop_pool WHERE dist_id = 'D_NOASK'), '0', 'c1 no live ask -> no fill');

-- claim 2
SELECT _assert_eq((SELECT count(*)::text FROM pack_drop_pool WHERE dist_id = 'D_UP'), '4', 'c2 nothing deleted');
SELECT _assert_eq((SELECT string_agg(DISTINCT pool_source, ',') FROM pack_drop_pool WHERE dist_id = 'D_UP'), 'atlas', 'c2 all atlas');
SELECT _assert_eq((SELECT drop_weight::text || '/' || orig_drop_weight::text FROM pack_drop_pool WHERE dist_id = 'D_UP' AND edition_flow_id = '20:9'), '0/50', 'c2 unlisted row zeroed, original count kept');
SELECT _assert_eq((SELECT round(drop_weight, 2)::text FROM pack_drop_pool WHERE dist_id = 'D_UP' AND edition_flow_id = '20:2'), '0.75', 'c2 re-weighted by remaining');

-- claim 3
SELECT _assert_eq((SELECT count(*)::text FROM pack_drop_pool WHERE dist_id IN ('D_UNMAPPED', 'D_EMPTY')), '0', 'c3 unmapped / empty skipped');
SELECT _assert_eq((SELECT string_agg(pool_source || ':' || drop_weight::text, ',' ORDER BY edition_flow_id) FROM pack_drop_pool WHERE dist_id = 'D_SHRINK'),
  'gql:0.5,gql:0.5', 'c3 smaller list keeps the old pool');
SELECT _assert_eq((SELECT extra->>'skipped' FROM _runs ORDER BY ctid DESC LIMIT 1), '3', 'c3 skipped counted');

-- claim 4: nothing newer -> no writes
SELECT _assert_eq((public.sync_topshot_pools_from_atlas(400)->>'rows_written'), '0', 'c4 idempotent re-run');
-- a later pg_cron run is a later transaction: age the pool as if it were written by one
UPDATE public.pack_drop_pool SET last_refreshed_at = now() - interval '30 minutes';
INSERT INTO public.topshot_atlas_dist_editions VALUES
  ('D_FILL','a1',2,10,1,'Standard','COMMON',60,1,0, now() + interval '1 minute'),
  ('D_FILL','a2',2,10,2,'Standard','COMMON',30,3,0, now() + interval '1 minute');
SELECT _assert_eq((public.sync_topshot_pools_from_atlas(400)->>'rewritten'), '1', 'c4 newer pass refreshes');
SELECT _assert_eq((SELECT round(drop_weight, 2)::text FROM pack_drop_pool WHERE dist_id = 'D_FILL' AND edition_flow_id = '10:2'), '0.75', 'c4 re-weighted');
SELECT _assert_eq((SELECT drop_weight::text FROM pack_drop_pool WHERE dist_id = 'D_FILL' AND edition_flow_id = '10:1::4'), '0', 'c4 dropped edition zeroed');

-- claim 5
ALTER TABLE public.pack_drop_pool RENAME TO pack_drop_pool_x;
SELECT _assert_eq((public.sync_topshot_pools_from_atlas(400)->>'ok'), 'false', 'c5 failure reported');
SELECT _assert_eq((SELECT ok::text FROM _runs ORDER BY ctid DESC LIMIT 1), 'false', 'c5 failure logged');

ROLLBACK;

-- audit_20261010_box_and_case_pack_ev_from_their_recipes
-- anon-exec: revoked (refresh_container_pack_ev) — new SECURITY DEFINER writer; REVOKE FROM PUBLIC, anon, authenticated below, GRANT to postgres + service_role.
--
-- 2026-10-10 (known-issues #188 item 1). No Top Shot box, case, topper or premium-pack distribution
-- had an EV (~70 dists): a box or case is a PackNFT that yields sealed PackNFTs, never moments, so
-- it has no pull pool; and its toppers / premium packs carry retail 0 (never sold alone), which
-- topshot_pack_ev_targets reads as a $0 reward pack and never targets. The Atlas sweep covers only
-- Atlas pools; these have gql_historical pools that compute_pack_ev_per_edition_weighted prices
-- fine (Metallic Gold LE Premium 7627: gross $114.82, 99 % coverage).
--
-- WHAT
--   pack_container_recipes   what one box / case yields: (container dist, inner dist, count).
--     'observed'    = every fully-resolved opened container of that dist (pack_box_contents x
--                     pack_nft_identity) -- 2026-10-10: 22 dists, 436 containers, ONE recipe each;
--     'supply'      = no opened container on record; derived from minted counts (premium =
--                     cases x 10, toppers = cases x 3 / boxes x 2; Origins Case: 16,260 standard
--                     - 2,252 boxes x 5 = 5,000 = 200 cases x 25);
--     'description' = Dapper's distribution description only (WNBA Rookie Revelation Courtside Box).
--     An observed recipe replaces a seeded one the first time a container of that dist is opened.
--   refresh_container_pack_ev()  hourly :28 (after the Atlas sweep at :25, before the MV at :33):
--     (1) re-derives observed recipes (write first, then delete only the pairs it did not write);
--     (2) prices every INNER dist no other lane prices (a non-Atlas pool, never targeted by the
--         edge function) with compute_pack_ev_per_edition_weighted, as refresh_atlas_pack_ev does;
--     (3) prices every CONTAINER = sum(count x inner gross_ev) -- only when EVERY inner dist has a
--         real EV row from the last 26 h; otherwise it is skipped and counted ('incomplete'),
--         never a partial sum. Coverage = the weakest inner coverage.
--     (1b) types every untyped container ('case' when its title says so, else 'box') and inner
--          dist ('pack'): Dapper's index has no pack_type for the dists from 8751 on (#188 item 2).
--   topshot_pack_ev_targets  now excludes containers: the edge function priced them from a moment
--     pool they do not have and wrote "$0 / none" sentinels (47 per box/case through 08-28).
--
-- REVERT:
--   SELECT cron.unschedule('rpc-container-pack-ev');
--   DELETE FROM public.pipeline_cadence_watchlist WHERE pipeline = 'topshot-container-pack-ev';
--   DROP FUNCTION public.refresh_container_pack_ev();
--   re-create topshot_pack_ev_targets from 20260801030919 (drop the container exclusion);
--   DROP TABLE public.pack_container_recipes;
--   (pack_ev_history rows it wrote are true snapshots; to remove them:
--    DELETE FROM pack_ev_history h USING pack_container_recipes ... before the DROP, then refresh_mv_pack_ev_latest().)

CREATE TABLE IF NOT EXISTS public.pack_container_recipes (
  collection_id      uuid NOT NULL,
  container_dist_id  text NOT NULL,
  inner_dist_id      text NOT NULL,
  inner_count        int  NOT NULL CHECK (inner_count > 0),
  source             text NOT NULL CHECK (source IN ('observed', 'supply', 'description')),
  observed_containers int,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (collection_id, container_dist_id, inner_dist_id)
);
COMMENT ON TABLE public.pack_container_recipes IS
  'What one box / case (a PackNFT that yields PackNFTs) contains: inner dist x count. observed = from opened containers (refresh_container_pack_ev re-derives), supply = minted-count arithmetic, description = Dapper''s text. 2026-10-10 (#188).';
ALTER TABLE public.pack_container_recipes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.pack_container_recipes FROM PUBLIC, anon, authenticated;

-- Seeds for containers with no opened container on record (observed ones are derived below).
INSERT INTO public.pack_container_recipes (collection_id, container_dist_id, inner_dist_id, inner_count, source) VALUES
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', '6218', '6214', 10, 'supply'),       -- Rookie Debut Case: premium 1,000 = 100 x 10
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', '6218', '6217',  3, 'supply'),       --   case toppers 300 = 100 x 3
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', '6411', '6409', 25, 'supply'),       -- Origins Case (28 slots): 16,260 - 2,252 x 5 = 5,000 = 200 x 25
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', '6411', '6407',  3, 'supply'),       --   case toppers 600 = 200 x 3
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', '8594', '8595',  5, 'supply'),       -- WNBA MGLE Box (7 slots)
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', '8594', '8598',  2, 'supply'),       --   box toppers 1,230 = 615 x 2
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', '8751', '8750',  5, 'supply'),       -- Run It Back: Origins Box (7 slots)
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', '8751', '8755',  2, 'supply'),       --   box toppers 740 = 370 x 2
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', '8752', '8754',  5, 'supply'),       -- Run It Back: Origins Case (8 slots): premium 215 = 43 x 5
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', '8752', '8753',  3, 'supply'),       --   case toppers 129 = 43 x 3
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', '8772', '8770',  5, 'description'),  -- WNBA RR Courtside Box: 5 standard
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', '8772', '8870',  1, 'description')   --   + 1 Courtside topper
ON CONFLICT (collection_id, container_dist_id, inner_dist_id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.refresh_container_pack_ev()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '120s'
AS $function$
DECLARE
  v_cid uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_now timestamptz := now();
  r record;
  ev jsonb;
  v_gross numeric;
  v_recipes int := 0;
  v_inner_written int := 0;
  v_inner_failed int := 0;
  v_written int := 0;
  v_incomplete int := 0;
  v_unkeyed int := 0;
  v_pairs text[];
  v_containers text[];
  v_typed int := 0;
BEGIN
  -- (1) observed recipes: every opened container whose inner packs the index names in full.
  --     A dist's recipe is its most common one (they agree today: one recipe per dist).
  --     Write first, then delete only the rows of a re-derived container it did not write.
  WITH x AS (
    SELECT bc.box_pack_nft_id, ob.dist_id AS od, ib.dist_id AS idd
    FROM pack_box_contents bc
    JOIN pack_nft_identity ob ON ob.collection_id = bc.collection_id AND ob.pack_nft_id = bc.box_pack_nft_id
    LEFT JOIN pack_nft_identity ib ON ib.collection_id = bc.collection_id AND ib.pack_nft_id = bc.pack_nft_id
    WHERE bc.collection_id = v_cid
  ),
  full_boxes AS (
    SELECT box_pack_nft_id FROM x GROUP BY 1
    HAVING bool_and(idd IS NOT NULL AND idd <> '0') AND count(DISTINCT od) = 1
  ),
  per_box AS (
    SELECT od, box_pack_nft_id, jsonb_object_agg(idd, n ORDER BY idd) AS recipe
    FROM (SELECT od, box_pack_nft_id, idd, count(*)::int AS n FROM x
          WHERE box_pack_nft_id IN (SELECT box_pack_nft_id FROM full_boxes) GROUP BY 1, 2, 3) y
    GROUP BY 1, 2
  ),
  modal AS (
    SELECT DISTINCT ON (od) od, recipe, count(*) OVER (PARTITION BY od, recipe) AS n_same,
           count(*) OVER (PARTITION BY od) AS n_all
    FROM per_box
    ORDER BY od, count(*) OVER (PARTITION BY od, recipe) DESC, recipe::text
  ),
  up AS (
    INSERT INTO pack_container_recipes (collection_id, container_dist_id, inner_dist_id, inner_count, source, observed_containers, updated_at)
    SELECT v_cid, m.od, e.key, e.value::int, 'observed', m.n_all, v_now
    FROM modal m CROSS JOIN LATERAL jsonb_each_text(m.recipe) e
    ON CONFLICT (collection_id, container_dist_id, inner_dist_id) DO UPDATE
      SET inner_count = EXCLUDED.inner_count, source = 'observed',
          observed_containers = EXCLUDED.observed_containers, updated_at = EXCLUDED.updated_at
    RETURNING container_dist_id, inner_dist_id
  )
  SELECT count(*), array_agg(container_dist_id || '|' || inner_dist_id), array_agg(DISTINCT container_dist_id)
    INTO v_recipes, v_pairs, v_containers FROM up;
  -- keyed on the exact pairs just written, never on a timestamp (a seed written in the same
  -- transaction carries the same now())
  DELETE FROM pack_container_recipes pr
   WHERE pr.collection_id = v_cid
     AND pr.container_dist_id = ANY (v_containers)
     AND NOT (pr.container_dist_id || '|' || pr.inner_dist_id = ANY (v_pairs));

  -- (1b) type what Dapper leaves untyped. Its index carries no pack_type (nor uuid, nor price)
  --      for the PDS-era dists from 8751 on, and 7156 has no metadata at all. A recipe's
  --      container IS a box or case and its inner dists ARE packs, by construction.
  --      Fill-only: a pack_type Dapper set is never overwritten.
  UPDATE pack_distributions pd
     SET metadata = COALESCE(pd.metadata, '{}'::jsonb) || jsonb_build_object('pack_type',
           CASE WHEN EXISTS (SELECT 1 FROM pack_container_recipes cr
                              WHERE cr.collection_id = v_cid AND cr.container_dist_id = pd.dist_id)
                THEN CASE WHEN pd.title ~* '\mcase\M' THEN 'case' ELSE 'box' END
                ELSE 'pack' END)
   WHERE pd.collection_id = v_cid
     AND COALESCE(pd.metadata->>'pack_type', '') = ''
     AND pd.dist_id IN (SELECT container_dist_id FROM pack_container_recipes WHERE collection_id = v_cid
                        UNION SELECT inner_dist_id FROM pack_container_recipes WHERE collection_id = v_cid);
  GET DIAGNOSTICS v_typed = ROW_COUNT;

  -- (2) inner dists no other lane prices: a non-Atlas pool (the Atlas sweep owns Atlas pools)
  --     and retail 0 / never sold alone (the edge function never targets them).
  FOR r IN
    SELECT DISTINCT pr.inner_dist_id AS dist_id,
           pd.metadata->>'uuid' AS listing_uuid,
           pd.title,
           GREATEST(COALESCE(NULLIF(pd.metadata->>'number_of_pack_slots', '')::int, 1), 1) AS slots,
           pas.lowest_ask, pd.total_sealed, pd.depletion_pct
    FROM pack_container_recipes pr
    JOIN pack_distributions pd ON pd.collection_id = pr.collection_id AND pd.dist_id = pr.inner_dist_id
    LEFT JOIN pack_ask_state pas ON pas.collection_slug = 'nba-top-shot' AND pas.dist_id = pr.inner_dist_id
                                 AND pas.is_listed IS TRUE AND pas.lowest_ask > 0
    WHERE pr.collection_id = v_cid
      AND pd.metadata->>'uuid' IS NOT NULL
      AND COALESCE(public.pack_retail_usd(pd.metadata->>'retail_price_usd'), 0) = 0
      AND EXISTS (SELECT 1 FROM pack_drop_pool p WHERE p.collection_id = v_cid AND p.dist_id = pr.inner_dist_id)
      AND NOT EXISTS (SELECT 1 FROM pack_drop_pool p WHERE p.collection_id = v_cid AND p.dist_id = pr.inner_dist_id
                       AND p.pool_source = 'atlas')
  LOOP
    ev := public.compute_pack_ev_per_edition_weighted(v_cid, r.dist_id, COALESCE(r.lowest_ask, 0), r.slots);
    IF (ev->>'ok')::boolean IS NOT TRUE THEN
      v_inner_failed := v_inner_failed + 1;   -- no row: a container needing it is then 'incomplete'
      CONTINUE;
    END IF;
    v_gross := (ev->>'gross_ev')::numeric;
    INSERT INTO pack_ev_history (pack_listing_id, collection_id, dist_id, pack_name, pack_price,
      primary_price, secondary_ask, price_source, primary_available, secondary_available,
      gross_ev, typical_ev, pack_ev, is_positive_ev, value_ratio, fmv_coverage_pct, edition_count, total_unopened, depletion_pct, snapshotted_at)
    VALUES (r.listing_uuid, v_cid, r.dist_id, r.title, COALESCE(r.lowest_ask, 0),
      NULL, r.lowest_ask, CASE WHEN r.lowest_ask > 0 THEN 'secondary' ELSE 'none' END,
      false, r.lowest_ask > 0,
      v_gross, (ev->>'typical_pull_ev')::numeric,
      GREATEST(LEAST(round(v_gross - COALESCE(r.lowest_ask, 0), 2), 1000000), -10000),
      COALESCE(r.lowest_ask > 0 AND (v_gross - r.lowest_ask) > 0, false),
      CASE WHEN r.lowest_ask > 0 THEN round(v_gross / r.lowest_ask, 3) ELSE NULL END,
      (ev->>'fmv_coverage_pct')::smallint, LEAST((ev->>'edition_count')::int, 32767), r.total_sealed, r.depletion_pct, v_now);
    v_inner_written := v_inner_written + 1;
  END LOOP;

  -- (3) containers: the sum of what they yield, only when EVERY inner dist has a real EV row
  --     (not the could-not-price sentinel) from the last 26 h. Never a partial sum.
  FOR r IN
    WITH latest AS (
      SELECT DISTINCT ON (h.dist_id) h.dist_id, h.gross_ev, h.typical_ev, h.fmv_coverage_pct, h.edition_count
      FROM pack_ev_history h
      WHERE h.collection_id = v_cid
        AND h.dist_id IN (SELECT inner_dist_id FROM pack_container_recipes WHERE collection_id = v_cid)
        AND h.snapshotted_at > v_now - interval '26 hours'
      ORDER BY h.dist_id, h.snapshotted_at DESC
    ),
    agg AS (
      SELECT pr.container_dist_id,
             count(*) AS n_inner,
             count(*) FILTER (WHERE l.gross_ev IS NOT NULL AND COALESCE(l.edition_count, 0) > 0) AS n_priced,
             sum(pr.inner_count * l.gross_ev) AS gross,
             CASE WHEN bool_and(l.typical_ev IS NOT NULL) THEN sum(pr.inner_count * l.typical_ev) END AS typical,
             min(l.fmv_coverage_pct) AS coverage,
             sum(l.edition_count) AS editions
      FROM pack_container_recipes pr
      LEFT JOIN latest l ON l.dist_id = pr.inner_dist_id
      WHERE pr.collection_id = v_cid
      GROUP BY 1
    )
    SELECT a.*, pd.metadata->>'uuid' AS listing_uuid, pd.title, pd.total_sealed, pd.depletion_pct, pas.lowest_ask
    FROM agg a
    JOIN pack_distributions pd ON pd.collection_id = v_cid AND pd.dist_id = a.container_dist_id
    LEFT JOIN pack_ask_state pas ON pas.collection_slug = 'nba-top-shot' AND pas.dist_id = a.container_dist_id
                                 AND pas.is_listed IS TRUE AND pas.lowest_ask > 0
  LOOP
    IF r.listing_uuid IS NULL THEN v_unkeyed := v_unkeyed + 1; CONTINUE; END IF;
    IF r.n_priced < r.n_inner THEN v_incomplete := v_incomplete + 1; CONTINUE; END IF;
    INSERT INTO pack_ev_history (pack_listing_id, collection_id, dist_id, pack_name, pack_price,
      primary_price, secondary_ask, price_source, primary_available, secondary_available,
      gross_ev, typical_ev, pack_ev, is_positive_ev, value_ratio, fmv_coverage_pct, edition_count, total_unopened, depletion_pct, snapshotted_at)
    VALUES (r.listing_uuid, v_cid, r.container_dist_id, r.title, COALESCE(r.lowest_ask, 0),
      NULL, r.lowest_ask, CASE WHEN r.lowest_ask > 0 THEN 'secondary' ELSE 'none' END,
      false, r.lowest_ask > 0,
      round(r.gross, 2), round(r.typical, 2),
      GREATEST(LEAST(round(r.gross - COALESCE(r.lowest_ask, 0), 2), 1000000), -10000),
      COALESCE(r.lowest_ask > 0 AND (r.gross - r.lowest_ask) > 0, false),
      CASE WHEN r.lowest_ask > 0 THEN round(r.gross / r.lowest_ask, 3) ELSE NULL END,
      r.coverage, LEAST(r.editions, 32767)::int, r.total_sealed, r.depletion_pct, v_now);
    v_written := v_written + 1;
  END LOOP;

  PERFORM public.log_pipeline_run('topshot-container-pack-ev', v_now, v_written + v_incomplete + v_unkeyed,
    v_written + v_inner_written, v_incomplete + v_unkeyed, true, NULL, 'nba-top-shot', NULL, NULL,
    jsonb_build_object('containers', v_written, 'incomplete', v_incomplete, 'unkeyed', v_unkeyed,
                       'inner_written', v_inner_written, 'inner_failed', v_inner_failed, 'recipe_rows', v_recipes,
                       'typed', v_typed));
  RETURN jsonb_build_object('ok', true, 'containers', v_written, 'incomplete', v_incomplete, 'unkeyed', v_unkeyed,
                            'inner_written', v_inner_written, 'inner_failed', v_inner_failed, 'recipe_rows', v_recipes,
                            'typed', v_typed);
EXCEPTION WHEN query_canceled OR OTHERS THEN
  -- the rows it wrote roll back with it, so rows_written is 0
  PERFORM public.log_pipeline_run('topshot-container-pack-ev', v_now, 0, 0, 0, false, left(SQLERRM, 300),
    'nba-top-shot', NULL, NULL, jsonb_build_object('reached_containers', v_written, 'reached_inner', v_inner_written));
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.refresh_container_pack_ev() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_container_pack_ev() TO postgres, service_role;
COMMENT ON FUNCTION public.refresh_container_pack_ev() IS
  'Box / case EV = sum of inner-pack EV per pack_container_recipes; also prices the container-only inner packs (toppers, premium packs). pg_cron rpc-container-pack-ev hourly :28. 2026-10-10 (#188).';

-- The edge function prices a pack from its moment pool; a container has none. It wrote
-- "$0 / none" sentinel rows for every box and case. Exclude containers from its targets.
-- security_invoker = on (it was a definer-mode view with no reloptions): its one reader is the
-- compute-topshot-pack-ev edge function as service_role, which bypasses RLS either way.
CREATE OR REPLACE VIEW public.topshot_pack_ev_targets WITH (security_invoker = on) AS
 SELECT pd.dist_id,
    (pd.metadata ->> 'uuid'::text) AS pack_listing_uuid,
    pd.title,
    (pd.metadata ->> 'tier'::text) AS tier,
        CASE
            WHEN (((pd.metadata ->> 'number_of_pack_slots'::text))::integer > 0) THEN ((pd.metadata ->> 'number_of_pack_slots'::text))::integer
            ELSE 1
        END AS slots,
        CASE
            WHEN ((pd.metadata ->> 'retail_price_usd'::text) IS NULL) THEN NULL::numeric
            WHEN (((pd.metadata ->> 'retail_price_usd'::text))::numeric >= (1000000)::numeric) THEN round((((pd.metadata ->> 'retail_price_usd'::text))::numeric / (100000000)::numeric), 2)
            ELSE round(((pd.metadata ->> 'retail_price_usd'::text))::numeric, 2)
        END AS retail_price_usd,
    pev.last_ev_at,
        CASE
            WHEN (pev.last_ev_at IS NULL) THEN NULL::interval
            ELSE (now() - pev.last_ev_at)
        END AS ev_age,
    pd.first_seen_at,
    pd.updated_at
   FROM (pack_distributions pd
     LEFT JOIN ( SELECT pack_ev_history.collection_id,
            pack_ev_history.dist_id,
            max(pack_ev_history.snapshotted_at) AS last_ev_at
           FROM pack_ev_history
          GROUP BY pack_ev_history.collection_id, pack_ev_history.dist_id) pev ON (((pev.collection_id = pd.collection_id) AND (pev.dist_id = pd.dist_id))))
  WHERE ((pd.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid) AND ((pd.metadata ->> 'uuid'::text) IS NOT NULL) AND ((COALESCE(((pd.metadata ->> 'retail_price_usd'::text))::numeric, (0)::numeric) > (0)::numeric) OR (pev.last_ev_at IS NOT NULL) OR ((pd.metadata ->> 'retail_price_usd'::text) IS NULL)) AND (NOT (EXISTS ( SELECT 1
           FROM pack_drop_pool p
          WHERE ((p.collection_id = pd.collection_id) AND (p.dist_id = pd.dist_id) AND (p.pool_source = 'atlas'::text)))))
    -- 2026-10-10 (#188): a box / case has no moment pool -- refresh_container_pack_ev prices it
    AND (NOT (EXISTS ( SELECT 1 FROM pack_container_recipes cr
          WHERE ((cr.collection_id = pd.collection_id) AND (cr.container_dist_id = pd.dist_id)))))
    AND COALESCE((pd.metadata ->> 'pack_type'::text), '') NOT IN ('box', 'case'));

INSERT INTO public.pipeline_cadence_watchlist (pipeline, max_silent_minutes, severity, notes, is_active, max_minutes_without_success)
VALUES ('topshot-container-pack-ev', 150, 'info',
  'pg_cron rpc-container-pack-ev (:28 hourly, postgres) -> refresh_container_pack_ev(): box / case EV from pack_container_recipes and the container-only inner packs (toppers, premium packs). 2026-10-10 (#188). Silence leaves the last snapshot in place; the pack page already flags an EV older than 72 h.',
  true, 300)
ON CONFLICT (pipeline) DO NOTHING;

SELECT cron.schedule('rpc-container-pack-ev', '28 * * * *', 'SELECT public.refresh_container_pack_ev();');

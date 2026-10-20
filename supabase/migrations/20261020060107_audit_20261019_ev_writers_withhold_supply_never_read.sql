-- 2026-10-19 (Claude Code cloud; Trevor: "Keep going ... until you've exhausted your capabilities").
--
-- THE WRITE SIDE OF "0% SEALED PACKS SOLD". refresh_atlas_pack_ev (:25) and refresh_container_pack_ev
-- (:28) copy pack_distributions.total_sealed / depletion_pct into every hourly EV snapshot. For a dist
-- whose supply was never read those columns are DEFAULTS: measured 2026-10-19 ~10:50 PM PT, 1,093 Top
-- Shot dists have no minted count and 0 of them carry any non-zero counter, while all 62 snapshots the
-- counter checks refute as "0 unopened at 0 %" (20261020044518) are such dists (PDS era, 8734+; 8785
-- with 9,431 opens observed). The reader fix withdraws them only while the hourly :34 verdict matches;
-- this stops writing them: no minted count -> total_unopened / depletion_pct NULL (unknown), the same
-- NULL the D-NOSUPPLY case already pins. A genuinely sold-out dist (minted > 0, sealed 0, 100 %) still
-- writes its measured 0/100.
--
-- anon-exec: unchanged (refresh_atlas_pack_ev) — CREATE OR REPLACE of an existing fn; ACL preserved, verified has_function_privilege anon=false 2026-10-19.
-- anon-exec: unchanged (refresh_container_pack_ev) — CREATE OR REPLACE of an existing fn; ACL preserved, verified has_function_privilege anon=false 2026-10-19.
--
-- Revert: re-apply both functions from 20261011050000 (repoint both pins).

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
  v_keyed_by_dist int := 0;
  v_now timestamptz := now();
BEGIN
  -- 2026-10-10 (#188): a dist with no Dapper listing uuid is keyed by its dist_id, the key
  -- live-pack-listings already falls back to (so pack_ask_state carries the same one).
  -- The 48 Atlas dists from 8734 on are absent from Dapper's distribution index altogether
  -- (searchDistributions byIDs: 0 of 48), so no uuid will ever arrive for them; skipping
  -- them left every PDS-era drop (Run It Back: Origins, WNBA Rookie Revelation) with no EV.

  FOR r IN
    SELECT DISTINCT p.dist_id,
           COALESCE(pd.metadata->>'uuid', p.dist_id) AS listing_uuid,
           (pd.metadata->>'uuid' IS NULL) AS keyed_by_dist,
           COALESCE(pd.title, pd.metadata->>'name') AS title,
           GREATEST(COALESCE((pd.metadata->>'number_of_pack_slots')::int, 1), 1) AS slots,
           pas.lowest_ask,
           -- 2026-10-19: a dist with no minted count was never read -- its counters are column defaults (0 of 1,093 carry a non-zero one), so withhold them
           CASE WHEN COALESCE(pd.total_minted, 0) > 0 THEN pd.total_sealed END AS total_sealed,
           CASE WHEN COALESCE(pd.total_minted, 0) > 0 THEN pd.depletion_pct END AS depletion_pct
    FROM pack_drop_pool p
    JOIN pack_distributions pd ON pd.collection_id = v_cid AND pd.dist_id = p.dist_id
    LEFT JOIN pack_ask_state pas ON pas.collection_slug = 'nba-top-shot' AND pas.dist_id = p.dist_id
                                 AND pas.is_listed IS TRUE AND pas.lowest_ask > 0
    WHERE p.collection_id = v_cid AND p.pool_source = 'atlas'
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
      IF r.keyed_by_dist THEN v_keyed_by_dist := v_keyed_by_dist + 1; END IF;
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
    IF r.keyed_by_dist THEN v_keyed_by_dist := v_keyed_by_dist + 1; END IF;
  END LOOP;

  PERFORM public.log_pipeline_run('topshot-atlas-pack-ev', v_now, v_written, v_written, 0, true, NULL,
    'nba-top-shot', NULL, NULL, jsonb_build_object('rows', v_written, 'keyed_by_dist_id', v_keyed_by_dist));
  RETURN jsonb_build_object('ok', true, 'written', v_written, 'keyed_by_dist_id', v_keyed_by_dist, 'finished_at', now());
EXCEPTION WHEN query_canceled OR OTHERS THEN
  -- a failed sweep LOGS (it used to return silently, leaving no pipeline_runs row); the
  -- rows it wrote roll back with it, so rows_written is 0
  PERFORM public.log_pipeline_run('topshot-atlas-pack-ev', v_now, v_written, 0, 0, false, left(SQLERRM, 300),
    'nba-top-shot', NULL, NULL, jsonb_build_object('rows', 0, 'reached', v_written));
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM, 'written', 0);
END;
$function$;

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
           -- 2026-10-10: no Dapper uuid -> keyed by dist_id (as refresh_atlas_pack_ev, live-pack-listings)
           COALESCE(pd.metadata->>'uuid', pr.inner_dist_id) AS listing_uuid,
           pd.title,
           GREATEST(COALESCE(NULLIF(pd.metadata->>'number_of_pack_slots', '')::int, 1), 1) AS slots,
           pas.lowest_ask,
           -- 2026-10-19: a dist with no minted count was never read -- its counters are column defaults (0 of 1,093 carry a non-zero one), so withhold them
           CASE WHEN COALESCE(pd.total_minted, 0) > 0 THEN pd.total_sealed END AS total_sealed, CASE WHEN COALESCE(pd.total_minted, 0) > 0 THEN pd.depletion_pct END AS depletion_pct
    FROM pack_container_recipes pr
    JOIN pack_distributions pd ON pd.collection_id = pr.collection_id AND pd.dist_id = pr.inner_dist_id
    LEFT JOIN pack_ask_state pas ON pas.collection_slug = 'nba-top-shot' AND pas.dist_id = pr.inner_dist_id
                                 AND pas.is_listed IS TRUE AND pas.lowest_ask > 0
    WHERE pr.collection_id = v_cid
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
    SELECT a.*, COALESCE(pd.metadata->>'uuid', a.container_dist_id) AS listing_uuid, pd.title,
           -- 2026-10-19: a dist with no minted count was never read -- its counters are column defaults (0 of 1,093 carry a non-zero one), so withhold them
           CASE WHEN COALESCE(pd.total_minted, 0) > 0 THEN pd.total_sealed END AS total_sealed, CASE WHEN COALESCE(pd.total_minted, 0) > 0 THEN pd.depletion_pct END AS depletion_pct, pas.lowest_ask
    FROM agg a
    JOIN pack_distributions pd ON pd.collection_id = v_cid AND pd.dist_id = a.container_dist_id
    LEFT JOIN pack_ask_state pas ON pas.collection_slug = 'nba-top-shot' AND pas.dist_id = a.container_dist_id
                                 AND pas.is_listed IS TRUE AND pas.lowest_ask > 0
  LOOP
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

  PERFORM public.log_pipeline_run('topshot-container-pack-ev', v_now, v_written + v_incomplete,
    v_written + v_inner_written, v_incomplete, true, NULL, 'nba-top-shot', NULL, NULL,
    jsonb_build_object('containers', v_written, 'incomplete', v_incomplete,
                       'inner_written', v_inner_written, 'inner_failed', v_inner_failed, 'recipe_rows', v_recipes,
                       'typed', v_typed));
  RETURN jsonb_build_object('ok', true, 'containers', v_written, 'incomplete', v_incomplete,
                            'inner_written', v_inner_written, 'inner_failed', v_inner_failed, 'recipe_rows', v_recipes,
                            'typed', v_typed);
EXCEPTION WHEN query_canceled OR OTHERS THEN
  -- the rows it wrote roll back with it, so rows_written is 0
  PERFORM public.log_pipeline_run('topshot-container-pack-ev', v_now, 0, 0, 0, false, left(SQLERRM, 300),
    'nba-top-shot', NULL, NULL, jsonb_build_object('reached_containers', v_written, 'reached_inner', v_inner_written));
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$function$;

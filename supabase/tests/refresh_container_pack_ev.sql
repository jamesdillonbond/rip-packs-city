-- DB invariant: public.refresh_container_pack_ev — a Top Shot box / case is valued as the sum of
-- what it yields (2026-10-10, known-issues #188). Claims it must keep:
--
--   1. A container's recipe is OBSERVED from opened containers whose inner packs the index names
--      in full; a partly-named container never shapes it, and an observed recipe replaces a
--      seeded one (write first, delete only what it did not write).
--   2. Container-only inner packs (retail 0, non-Atlas pool) are priced here; an Atlas-pool inner
--      pack is left to the Atlas sweep, and a pack sold alone (retail > 0) to the edge function.
--   3. Container gross EV = sum(count x inner gross EV), written only when EVERY inner dist has a
--      real EV row from the last 26 h -- a stale row, the could-not-price sentinel
--      (edition_count 0) or a failed inner price makes it 'incomplete': no row, never a partial sum.
--   4. A container with no listing uuid is counted 'unkeyed', not written.
--   5. An untyped container is typed 'case' / 'box' (by its title), an untyped inner dist 'pack';
--      a pack_type Dapper set is never overwritten.
--
-- The function DDL below is VERBATIM from the committed migration
-- (supabase/migrations/20261011020800_audit_20261010_box_and_case_pack_ev_from_their_recipes.sql).
-- __tests__/db-invariants-drift-guard.test.ts fails CI on drift.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE public.pack_box_contents (collection_id uuid NOT NULL, box_pack_nft_id text NOT NULL, pack_nft_id text NOT NULL,
  opener_address text NOT NULL, first_seen_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (collection_id, box_pack_nft_id, pack_nft_id));
CREATE TABLE public.pack_nft_identity (collection_id uuid, pack_nft_id text, dist_id text, PRIMARY KEY (collection_id, pack_nft_id));
CREATE TABLE public.pack_container_recipes (
  collection_id uuid NOT NULL, container_dist_id text NOT NULL, inner_dist_id text NOT NULL,
  inner_count int NOT NULL CHECK (inner_count > 0),
  source text NOT NULL CHECK (source IN ('observed', 'supply', 'description')),
  observed_containers int, updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (collection_id, container_dist_id, inner_dist_id));
CREATE TABLE public.pack_distributions (collection_id uuid, dist_id text, title text, metadata jsonb, total_sealed int, depletion_pct smallint);
CREATE TABLE public.pack_ask_state (collection_slug text, dist_id text, lowest_ask numeric, is_listed boolean);
CREATE TABLE public.pack_drop_pool (collection_id uuid, dist_id text, pool_source text);
CREATE TABLE public.pack_ev_history (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY, pack_listing_id text NOT NULL, collection_id uuid NOT NULL, dist_id text,
  pack_name text, pack_price numeric, gross_ev numeric NOT NULL, pack_ev numeric NOT NULL, is_positive_ev boolean NOT NULL,
  value_ratio numeric, fmv_coverage_pct smallint, edition_count smallint, total_unopened int, depletion_pct smallint,
  snapshotted_at timestamptz NOT NULL, primary_price numeric, secondary_ask numeric, price_source text,
  primary_available boolean, secondary_available boolean, typical_ev numeric,
  CONSTRAINT pack_ev_history_pack_ev_sane_range CHECK (pack_ev >= -10000 AND pack_ev <= 1000000));
CREATE TABLE public.pipeline_runs_stub (pipeline text, ok boolean, rows_written int, extra jsonb);
CREATE FUNCTION public.log_pipeline_run(p_pipeline text, p_started_at timestamptz, p_rows_found int, p_rows_written int,
  p_rows_skipped int, p_ok boolean, p_error text, p_collection_slug text, p_cursor_before text, p_cursor_after text, p_extra jsonb)
RETURNS bigint LANGUAGE sql AS $$ INSERT INTO public.pipeline_runs_stub VALUES (p_pipeline, p_ok, p_rows_written, p_extra) RETURNING 1::bigint $$;
CREATE FUNCTION public.pack_retail_usd(p_raw text) RETURNS numeric LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN p_raw IS NULL OR p_raw !~ '^\s*[0-9]+(\.[0-9]+)?\s*$' THEN NULL ELSE p_raw::numeric END $$;
-- the per-edition EV engine is stubbed: a fixture answer per dist (and a record of the calls)
CREATE TABLE public.ev_stub (dist_id text PRIMARY KEY, answer jsonb);
CREATE TABLE public.ev_calls (dist_id text, slots int);
CREATE FUNCTION public.compute_pack_ev_per_edition_weighted(p_cid uuid, p_dist text, p_price numeric, p_slots int)
RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public.ev_calls VALUES (p_dist, p_slots);
  RETURN COALESCE((SELECT answer FROM public.ev_stub WHERE dist_id = p_dist), '{"ok":false,"reason":"no_pool"}'::jsonb);
END $$;

-- >>> BEGIN verbatim refresh_container_pack_ev (body byte-identical to the migration) >>>
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
-- <<< END verbatim refresh_container_pack_ev <<<

-- Fixtures. BOX (dist B): 5 x S (standard, sold alone at $25, Atlas pool) + 2 x T (topper, retail 0).
-- CASE (dist C): 10 x P (premium, retail 0) + 3 x T2 (case topper, retail 0) -- P cannot be priced.
-- NOKEY (dist K): a container with no listing uuid. STALE (dist L): its inner pack's row is 30 h old.
INSERT INTO public.pack_distributions VALUES
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'B',  'Test Box',      '{"uuid":"u-B","retail_price_usd":"250","pack_type":"box"}', 4, 96),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'S',  'Standard',      '{"uuid":"u-S","retail_price_usd":"25","number_of_pack_slots":"5"}', 300, 96),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'T',  'Box Topper',    '{"uuid":"u-T","retail_price_usd":"0"}', 90, 95),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'C',  'Test Case',     '{"uuid":"u-C","retail_price_usd":"2500","pack_type":"case"}', 9, 91),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'P',  'Premium',       '{"uuid":"u-P","retail_price_usd":"0","number_of_pack_slots":"4"}', 110, 89),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'T2', 'Case Topper',   '{"uuid":"u-T2","retail_price_usd":"0"}', 34, 89),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'K',  'No-uuid Case',  '{"retail_price_usd":"2500","pack_type":null}', 5, 50),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'L',  'Stale Box',     '{"uuid":"u-L","retail_price_usd":"150"}', 5, 50),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'LS', 'Stale Standard','{"uuid":"u-LS","retail_price_usd":"20"}', 5, 50);
INSERT INTO public.pack_drop_pool VALUES
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'S',  'atlas'),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'T',  'gql_historical'),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'P',  'gql_historical'),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'T2', 'gql_historical'),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'LS', 'atlas');
INSERT INTO public.pack_ask_state VALUES ('nba-top-shot', 'B', 200, true), ('nba-top-shot', 'T', 60, true), ('nba-top-shot', 'C', 3000, true);
INSERT INTO public.ev_stub VALUES
  ('T',  '{"ok":true,"gross_ev":30,"typical_pull_ev":7,"fmv_coverage_pct":100,"edition_count":89}'),
  ('T2', '{"ok":true,"gross_ev":135.5,"typical_pull_ev":65,"fmv_coverage_pct":91,"edition_count":47}');
-- S's own EV comes from the Atlas sweep (a fresh real row); LS's is 30 h old
INSERT INTO public.pack_ev_history (pack_listing_id, collection_id, dist_id, pack_name, pack_price, gross_ev, typical_ev, pack_ev, is_positive_ev, fmv_coverage_pct, edition_count, snapshotted_at) VALUES
  ('u-S',  '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'S',  'Standard', 18, 10, 2, -8, false, 97, 228, now() - interval '20 minutes'),
  ('u-LS', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'LS', 'Stale Standard', 18, 10, 2, -8, false, 100, 50, now() - interval '30 hours');
-- Opened boxes: BX1, BX2 fully named (5 S + 2 T); BX3 has an unnamed inner pack (never shapes the recipe).
INSERT INTO public.pack_nft_identity VALUES
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'BX1', 'B'), ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'BX2', 'B'),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'BX3', 'B'), ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'CX1', 'C');
INSERT INTO public.pack_box_contents (collection_id, box_pack_nft_id, pack_nft_id, opener_address)
SELECT '95f28a17-224a-4025-96ad-adf8a4c63bfd', b, b || '-' || k, '0xo'
FROM unnest(ARRAY['BX1','BX2','BX3']) b, generate_series(1, 7) k;
INSERT INTO public.pack_nft_identity
SELECT '95f28a17-224a-4025-96ad-adf8a4c63bfd', b || '-' || k, CASE WHEN k <= 5 THEN 'S' ELSE 'T' END
FROM unnest(ARRAY['BX1','BX2']) b, generate_series(1, 7) k;
-- BX3: six named as 4 S + 2 T, one unnamed -- a 4/2 recipe must never appear
INSERT INTO public.pack_nft_identity
SELECT '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'BX3-' || k, CASE WHEN k <= 4 THEN 'S' ELSE 'T' END FROM generate_series(1, 6) k;
-- CX1: 10 P + 3 T2, all named
INSERT INTO public.pack_box_contents (collection_id, box_pack_nft_id, pack_nft_id, opener_address)
SELECT '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'CX1', 'CX1-' || k, '0xo' FROM generate_series(1, 13) k;
INSERT INTO public.pack_nft_identity
SELECT '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'CX1-' || k, CASE WHEN k <= 10 THEN 'P' ELSE 'T2' END FROM generate_series(1, 13) k;
-- seeds: a WRONG seeded recipe for B (observed must replace it), and the unobserved K and L
INSERT INTO public.pack_container_recipes (collection_id, container_dist_id, inner_dist_id, inner_count, source) VALUES
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'B', 'S', 4, 'supply'),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'B', 'X', 3, 'supply'),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'K', 'T', 2, 'supply'),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'L', 'LS', 5, 'supply');

DO $$
DECLARE v jsonb; row_ record;
BEGIN
  v := public.refresh_container_pack_ev();
  PERFORM _assert((v->>'ok')::boolean, 'run ok');
  -- 1. recipes
  PERFORM _assert_eq((SELECT string_agg(inner_dist_id || 'x' || inner_count || ':' || source, ',' ORDER BY inner_dist_id)
                        FROM public.pack_container_recipes WHERE container_dist_id = 'B'),
                     'Sx5:observed,Tx2:observed', 'B observed 5 S + 2 T replaces the wrong seed (S x4, X x3 gone); BX3 never shapes it');
  PERFORM _assert_eq((SELECT observed_containers::text FROM public.pack_container_recipes WHERE container_dist_id = 'B' AND inner_dist_id = 'S'),
                     '2', 'only the two fully-named boxes are counted');
  PERFORM _assert_eq((SELECT string_agg(source, ',') FROM public.pack_container_recipes WHERE container_dist_id = 'L'),
                     'supply', 'an unobserved seed is kept');
  -- 2. inner pricing: T, P, T2 tried (retail 0, non-Atlas pool); S and LS (Atlas) never
  PERFORM _assert_eq((SELECT string_agg(DISTINCT dist_id, ',' ORDER BY dist_id) FROM public.ev_calls), 'P,T,T2',
                     'only container-only, non-Atlas inner packs are priced here');
  PERFORM _assert_eq((SELECT slots::text FROM public.ev_calls WHERE dist_id = 'P' LIMIT 1), '4', 'priced with its own slot count');
  SELECT * INTO row_ FROM public.pack_ev_history WHERE dist_id = 'T';
  PERFORM _assert(row_.gross_ev = 30 AND row_.pack_ev = -30 AND row_.pack_price = 60 AND row_.pack_listing_id = 'u-T',
                  'T topper EV row: $30 gross vs its $60 ask');
  PERFORM _assert(NOT EXISTS (SELECT 1 FROM public.pack_ev_history WHERE dist_id = 'P'), 'P could not be priced: no row');
  -- 3. containers
  SELECT * INTO row_ FROM public.pack_ev_history WHERE dist_id = 'B';
  PERFORM _assert_eq(row_.gross_ev::text, '110.00', 'B = 5 x 10 + 2 x 30');
  PERFORM _assert(row_.typical_ev = 24 AND row_.pack_ev = -90 AND row_.is_positive_ev = false AND row_.value_ratio = 0.55
                  AND row_.fmv_coverage_pct = 97 AND row_.pack_listing_id = 'u-B' AND row_.price_source = 'secondary',
                  'B: typical 5x2 + 2x7, -$90 vs the $200 ask, coverage = the weakest inner (97)');
  PERFORM _assert(NOT EXISTS (SELECT 1 FROM public.pack_ev_history WHERE dist_id = 'C'), 'C: P unpriced -> no row, never 3 x T2 alone');
  PERFORM _assert(NOT EXISTS (SELECT 1 FROM public.pack_ev_history WHERE dist_id = 'L'), 'L: its inner row is 30 h old -> incomplete');
  PERFORM _assert(NOT EXISTS (SELECT 1 FROM public.pack_ev_history WHERE dist_id = 'K'), 'K: no listing uuid -> unkeyed');
  PERFORM _assert(v->>'containers' = '1' AND v->>'incomplete' = '2' AND v->>'unkeyed' = '1' AND v->>'inner_written' = '2'
                  AND v->>'inner_failed' = '1', 'counts: 1 written, C + L incomplete, K unkeyed, T + T2 priced, P failed');
  PERFORM _assert_eq((SELECT ok::text FROM public.pipeline_runs_stub WHERE pipeline = 'topshot-container-pack-ev'), 'true', 'logged');
  -- 5. typing
  PERFORM _assert_eq((SELECT string_agg(dist_id || '=' || (metadata->>'pack_type'), ',' ORDER BY dist_id) FROM public.pack_distributions
                       WHERE dist_id IN ('B','C','K','L','LS','T')),
                     'B=box,C=case,K=case,L=box,LS=pack,T=pack', 'untyped K (Case) / L (Box) / LS / T typed; B and C keep Dapper''s');
END $$;

-- A sentinel inner row (edition_count 0 = could not price) is not an EV: the container is incomplete.
DELETE FROM public.pack_ev_history;
DELETE FROM public.ev_stub WHERE dist_id = 'T';
INSERT INTO public.ev_stub VALUES ('T', '{"ok":true,"gross_ev":0,"typical_pull_ev":0,"fmv_coverage_pct":0,"edition_count":0}');
INSERT INTO public.pack_ev_history (pack_listing_id, collection_id, dist_id, pack_name, pack_price, gross_ev, typical_ev, pack_ev, is_positive_ev, fmv_coverage_pct, edition_count, snapshotted_at)
VALUES ('u-S', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'S', 'Standard', 18, 10, 2, -8, false, 97, 228, now() - interval '5 minutes');
DO $$
BEGIN
  PERFORM public.refresh_container_pack_ev();
  PERFORM _assert(NOT EXISTS (SELECT 1 FROM public.pack_ev_history WHERE dist_id = 'B'),
                  'B: its topper''s row is the could-not-price sentinel -> no box row (never 5 x 10 alone)');
END $$;

ROLLBACK;

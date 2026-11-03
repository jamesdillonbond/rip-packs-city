-- DB invariant: the #226 chain reconcile — reconcile_topshot_map_with_checkpoint + _apply_topshot_reconcile_run
-- (+ topshot_checkpoint_base, which it uses to require every spork record to agree).
--
-- Pinned behaviour:
--   * a map row whose base disagrees with the chain mint record is repointed, with its wmc / sales /
--     moments / id-map rows, to base (sub 0) or base::N (sub N);
--   * NOT repointed: sporks disagreeing, target edition missing, subedition still NULL, already agreeing;
--   * a moments row whose (target edition, serial) is taken by another nft is left where it is;
--   * the slice never passes the newest record (cursor stops at newest + 1, then wraps);
--   * a full batch (candidates = p_max) does not advance the cursor.
-- DDL below is a verbatim copy of the committed migrations (drift-guarded). Rolled back.

BEGIN;

CREATE TABLE checkpoint_nft_meta (spork smallint, c text, nft_id bigint, a bigint, b bigint, serial bigint, loaded_at timestamptz DEFAULT now(),
  PRIMARY KEY (c, nft_id, spork));
CREATE TABLE topshot_moment_subeditions (nft_id text PRIMARY KEY, base_external_id text, subedition_id integer);
CREATE TABLE editions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), collection_id uuid, external_id text);
CREATE TABLE wallet_moments_cache (collection_id uuid, wallet_address text, moment_id text, edition_key text);
CREATE TABLE sales (id serial, collection_id uuid, nft_id text, edition_id uuid);
CREATE TABLE moments (nft_id text, collection_id uuid, edition_id uuid, serial_number integer, updated_at timestamptz);
CREATE TABLE topshot_moment_id_editions (id bigint PRIMARY KEY, edition_external_id text);
CREATE TABLE topshot_atlas_reconcile_log (
  run_id uuid NOT NULL, nft_id text NOT NULL, from_base text NOT NULL, to_base text NOT NULL, subedition integer NOT NULL,
  to_key text NOT NULL, wmc_rows integer, sales_rows integer, moment_rows integer, idmap_rows integer,
  logged_at timestamptz NOT NULL DEFAULT now(), source text NOT NULL DEFAULT 'atlas', PRIMARY KEY (run_id, nft_id));
CREATE TABLE topshot_checkpoint_reconcile_cursor (id integer PRIMARY KEY DEFAULT 1, next_nft bigint NOT NULL,
  sweeps integer NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE _runs (pipeline text, ok boolean, rows_found integer, rows_written integer, extra jsonb);
CREATE FUNCTION log_pipeline_run(p1 text, p2 timestamptz, p3 integer, p4 integer, p5 integer, p6 boolean, p7 text,
  p8 text, p9 text, p10 text, p11 jsonb) RETURNS void LANGUAGE sql AS $$ INSERT INTO _runs VALUES (p1, p6, p3, p4, p11) $$;

-- >>> BEGIN verbatim topshot_checkpoint_base (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.topshot_checkpoint_base(p_nft_id text)
 RETURNS text
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  SELECT CASE WHEN count(DISTINCT (c.a, c.b)) = 1 THEN min(c.a::text || ':' || c.b::text) END
    FROM public.checkpoint_nft_meta c
   WHERE p_nft_id ~ '^[0-9]{1,18}$'
     AND c.c = 'ts' AND c.nft_id = p_nft_id::bigint;
$function$;
-- <<< END verbatim topshot_checkpoint_base <<<

-- >>> BEGIN verbatim _apply_topshot_reconcile_run (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public._apply_topshot_reconcile_run(p_run uuid)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  ts       constant uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_sub int := 0; v_wmc int := 0; v_sales int := 0; v_mom int := 0; v_idm int := 0;
BEGIN
  UPDATE public.topshot_moment_subeditions t SET base_external_id = l.to_base
    FROM public.topshot_atlas_reconcile_log l WHERE l.run_id = p_run AND l.nft_id = t.nft_id;
  GET DIAGNOSTICS v_sub = ROW_COUNT;

  WITH u AS (
    UPDATE public.wallet_moments_cache w SET edition_key = l.to_key
      FROM public.topshot_atlas_reconcile_log l
     WHERE l.run_id = p_run AND w.collection_id = ts AND w.moment_id = l.nft_id AND w.edition_key <> l.to_key
    RETURNING w.moment_id)
  UPDATE public.topshot_atlas_reconcile_log l SET wmc_rows = x.n
    FROM (SELECT moment_id, count(*) n FROM u GROUP BY 1) x WHERE l.run_id = p_run AND l.nft_id = x.moment_id;

  WITH u AS (
    UPDATE public.sales s SET edition_id = tg.id
      FROM public.topshot_atlas_reconcile_log l, public.editions tg
     WHERE l.run_id = p_run AND s.collection_id = ts AND s.nft_id = l.nft_id
       AND tg.collection_id = ts AND tg.external_id = l.to_key AND s.edition_id <> tg.id
    RETURNING s.nft_id)
  UPDATE public.topshot_atlas_reconcile_log l SET sales_rows = x.n
    FROM (SELECT nft_id, count(*) n FROM u GROUP BY 1) x WHERE l.run_id = p_run AND l.nft_id = x.nft_id;

  WITH u AS (
    UPDATE public.moments m SET edition_id = tg.id, updated_at = now()
      FROM public.topshot_atlas_reconcile_log l, public.editions tg
     WHERE l.run_id = p_run AND m.collection_id = ts AND m.nft_id = l.nft_id
       AND tg.collection_id = ts AND tg.external_id = l.to_key AND m.edition_id <> tg.id
       AND NOT EXISTS (SELECT 1 FROM public.moments o WHERE o.edition_id = tg.id
                          AND o.serial_number = m.serial_number AND o.nft_id <> m.nft_id)
    RETURNING m.nft_id)
  UPDATE public.topshot_atlas_reconcile_log l SET moment_rows = x.n
    FROM (SELECT nft_id, count(*) n FROM u GROUP BY 1) x WHERE l.run_id = p_run AND l.nft_id = x.nft_id;

  WITH u AS (
    UPDATE public.topshot_moment_id_editions i SET edition_external_id = l.to_key
      FROM public.topshot_atlas_reconcile_log l
     WHERE l.run_id = p_run AND l.nft_id ~ '^[0-9]{1,18}$' AND i.id = l.nft_id::bigint AND i.edition_external_id <> l.to_key
    RETURNING i.id::text AS nft_id)
  UPDATE public.topshot_atlas_reconcile_log l SET idmap_rows = 1
    FROM u WHERE l.run_id = p_run AND l.nft_id = u.nft_id;

  SELECT COALESCE(sum(wmc_rows),0), COALESCE(sum(sales_rows),0), COALESCE(sum(moment_rows),0), COALESCE(sum(idmap_rows),0)
    INTO v_wmc, v_sales, v_mom, v_idm
    FROM public.topshot_atlas_reconcile_log WHERE run_id = p_run;

  RETURN jsonb_build_object('map_rows', v_sub, 'wmc_rows', v_wmc, 'sales_rows', v_sales,
                            'moment_rows', v_mom, 'idmap_rows', v_idm);
END;
$function$;
-- <<< END verbatim _apply_topshot_reconcile_run <<<

-- >>> BEGIN verbatim reconcile_topshot_map_with_checkpoint (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.reconcile_topshot_map_with_checkpoint(p_slice bigint DEFAULT 200000, p_max integer DEFAULT 2000)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  ts       constant uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_run    uuid := gen_random_uuid();
  v_start  timestamptz := clock_timestamp();
  v_lo     bigint; v_hi bigint; v_top bigint; v_next bigint;
  v_wrapped boolean := false;
  v_cand   int := 0; v_missing int := 0;
  v_res    jsonb := '{}'::jsonb;
  v_err    text;
BEGIN
  BEGIN
    SELECT next_nft INTO v_lo FROM public.topshot_checkpoint_reconcile_cursor WHERE id = 1 FOR UPDATE;
    SELECT max(nft_id) INTO v_top FROM public.checkpoint_nft_meta WHERE c = 'ts';
    IF v_lo IS NULL OR v_top IS NULL OR v_lo > v_top THEN
      v_lo := 52038407; v_wrapped := true;
    END IF;
    -- Never past the newest record: a slice beyond it would advance the cursor over moments whose
    -- mint records have not landed yet (11-02: the cursor jumped 52.24M -> 52.44M with the walk at 52.19M).
    v_hi := LEAST(v_lo + GREATEST(p_slice, 1), v_top + 1);

    INSERT INTO public.topshot_atlas_reconcile_log (run_id, nft_id, from_base, to_base, subedition, to_key, source)
    SELECT v_run, x.nft_id, x.old_base, x.new_base, x.sub,
           x.new_base || CASE WHEN x.sub > 0 THEN '::' || x.sub ELSE '' END, 'checkpoint'
      FROM (
        SELECT DISTINCT ON (t.nft_id) t.nft_id, t.base_external_id AS old_base, t.subedition_id AS sub,
               k.a::text || ':' || k.b::text AS new_base
          FROM public.checkpoint_nft_meta k
          JOIN public.topshot_moment_subeditions t ON t.nft_id = k.nft_id::text
         WHERE k.c = 'ts' AND k.nft_id >= v_lo AND k.nft_id < v_hi
           AND t.subedition_id IS NOT NULL
           AND t.base_external_id IS DISTINCT FROM k.a::text || ':' || k.b::text
         ORDER BY t.nft_id
      ) x
     WHERE public.topshot_checkpoint_base(x.nft_id) = x.new_base   -- every spork record agrees
       AND EXISTS (SELECT 1 FROM public.editions e WHERE e.collection_id = ts
                      AND e.external_id = x.new_base || CASE WHEN x.sub > 0 THEN '::' || x.sub ELSE '' END)
     ORDER BY x.nft_id
     LIMIT GREATEST(p_max, 0);
    GET DIAGNOSTICS v_cand = ROW_COUNT;

    IF v_cand > 0 THEN
      v_res := public._apply_topshot_reconcile_run(v_run);
    END IF;

    -- A full batch means the slice may hold more: stay on it. Otherwise move to the next slice.
    v_next := CASE WHEN v_cand >= p_max THEN v_lo ELSE v_hi END;
    UPDATE public.topshot_checkpoint_reconcile_cursor
       SET next_nft = v_next, sweeps = sweeps + CASE WHEN v_wrapped THEN 1 ELSE 0 END, updated_at = now()
     WHERE id = 1;
  EXCEPTION WHEN query_canceled OR OTHERS THEN
    v_err := left(SQLERRM, 300);
  END;

  PERFORM public.log_pipeline_run(
    'topshot-map-checkpoint-reconcile', v_start, v_cand,
    CASE WHEN v_err IS NULL THEN COALESCE((v_res->>'map_rows')::int, 0) ELSE 0 END, 0,
    v_err IS NULL, v_err, 'nba_top_shot', NULL, NULL,
    v_res || jsonb_build_object('run_id', v_run, 'candidates', v_cand, 'slice_lo', v_lo, 'slice_hi', v_hi,
                                'next_nft', v_next, 'wrapped', v_wrapped, 'newest_record', v_top, 'cap', p_max,
                                'duration_ms', (extract(epoch FROM clock_timestamp() - v_start) * 1000)::int));
  RETURN v_res || jsonb_build_object('ok', v_err IS NULL, 'run_id', v_run, 'candidates', v_cand,
                                     'slice_lo', v_lo, 'slice_hi', v_hi, 'next_nft', v_next, 'error', v_err);
END;
$function$;
-- <<< END verbatim reconcile_topshot_map_with_checkpoint <<<

INSERT INTO topshot_checkpoint_reconcile_cursor (id, next_nft) VALUES (1, 52038407);
INSERT INTO editions (collection_id, external_id) VALUES
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', '1:1'), ('95f28a17-224a-4025-96ad-adf8a4c63bfd', '2:2'), ('95f28a17-224a-4025-96ad-adf8a4c63bfd', '2:2::16'), ('95f28a17-224a-4025-96ad-adf8a4c63bfd', '3:3'), ('95f28a17-224a-4025-96ad-adf8a4c63bfd', '4:4');

-- 52038407 wrong base, sub 0  -> 2:2
-- 52038408 wrong base, sub 16 -> 2:2::16
-- 52038409 sporks disagree (128 says 3:3, 28 says 4:4) -> skipped
-- 52038410 target 5:5 has no edition -> skipped
-- 52038411 subedition NULL -> skipped
-- 52038412 already agrees -> not a candidate
-- 52038413 wrong base; its moments row collides on (2:2, serial 7) with nft 999 -> map moves, moment stays
INSERT INTO checkpoint_nft_meta (spork, c, nft_id, a, b) VALUES
  (128,'ts',52038407,2,2),(128,'ts',52038408,2,2),(128,'ts',52038409,3,3),(28,'ts',52038409,4,4),
  (128,'ts',52038410,5,5),(128,'ts',52038411,2,2),(128,'ts',52038412,1,1),(128,'ts',52038413,2,2);
INSERT INTO topshot_moment_subeditions VALUES
  ('52038407','1:1',0),('52038408','1:1',16),('52038409','1:1',0),('52038410','1:1',0),
  ('52038411','1:1',NULL),('52038412','1:1',0),('52038413','1:1',0);
INSERT INTO wallet_moments_cache VALUES ('95f28a17-224a-4025-96ad-adf8a4c63bfd','0xa','52038407','1:1'), ('95f28a17-224a-4025-96ad-adf8a4c63bfd','0xa','52038408','1:1');
INSERT INTO sales (collection_id, nft_id, edition_id) SELECT '95f28a17-224a-4025-96ad-adf8a4c63bfd', '52038407', id FROM editions WHERE external_id='1:1';
INSERT INTO moments (nft_id, collection_id, edition_id, serial_number) SELECT '52038407', '95f28a17-224a-4025-96ad-adf8a4c63bfd', id, 5 FROM editions WHERE external_id='1:1';
INSERT INTO moments (nft_id, collection_id, edition_id, serial_number) SELECT '52038413', '95f28a17-224a-4025-96ad-adf8a4c63bfd', id, 7 FROM editions WHERE external_id='1:1';
INSERT INTO moments (nft_id, collection_id, edition_id, serial_number) SELECT '999', '95f28a17-224a-4025-96ad-adf8a4c63bfd', id, 7 FROM editions WHERE external_id='2:2';
INSERT INTO topshot_moment_id_editions VALUES (52038407, '1:1');

-- 1) p_max = 1: one candidate, and a full batch keeps the cursor on the slice.
SELECT _assert_eq((SELECT (reconcile_topshot_map_with_checkpoint(1000, 1))->>'candidates'), '1', 'p_max 1 takes one candidate');
SELECT _assert_eq((SELECT next_nft::text FROM topshot_checkpoint_reconcile_cursor), '52038407', 'a full batch does not advance the cursor');

-- 2) Full run: the remaining two candidates; the slice stops at newest + 1 (52038414), never lo + slice.
SELECT _assert_eq((SELECT (reconcile_topshot_map_with_checkpoint(1000, 2000))->>'candidates'), '2', 'the other two candidates');
SELECT _assert_eq((SELECT next_nft::text FROM topshot_checkpoint_reconcile_cursor), '52038414', '⛔ the cursor stops at the newest record + 1, not 1,000 ids past it');

SELECT _assert_eq((SELECT base_external_id FROM topshot_moment_subeditions WHERE nft_id='52038407'), '2:2', 'sub 0 repointed to the chain base');
SELECT _assert_eq((SELECT base_external_id FROM topshot_moment_subeditions WHERE nft_id='52038408'), '2:2', 'sub 16 repointed');
SELECT _assert_eq((SELECT edition_key FROM wallet_moments_cache WHERE moment_id='52038408'), '2:2::16', 'wmc key carries the chain subedition');
SELECT _assert_eq((SELECT edition_key FROM wallet_moments_cache WHERE moment_id='52038407'), '2:2', 'wmc key repointed');
SELECT _assert_eq((SELECT e.external_id FROM sales s JOIN editions e ON e.id=s.edition_id WHERE s.nft_id='52038407'), '2:2', 'sale repointed');
SELECT _assert_eq((SELECT e.external_id FROM moments m JOIN editions e ON e.id=m.edition_id WHERE m.nft_id='52038407'), '2:2', 'moment repointed');
SELECT _assert_eq((SELECT edition_external_id FROM topshot_moment_id_editions WHERE id=52038407), '2:2', 'id map repointed');
SELECT _assert_eq((SELECT base_external_id FROM topshot_moment_subeditions WHERE nft_id='52038413'), '2:2', 'collision case: the map still moves');
SELECT _assert_eq((SELECT e.external_id FROM moments m JOIN editions e ON e.id=m.edition_id WHERE m.nft_id='52038413'), '1:1', 'a moment whose (edition, serial) is taken stays put');

SELECT _assert_eq((SELECT base_external_id FROM topshot_moment_subeditions WHERE nft_id='52038409'), '1:1', '⛔ disagreeing sporks never repoint');
SELECT _assert_eq((SELECT base_external_id FROM topshot_moment_subeditions WHERE nft_id='52038410'), '1:1', 'no target edition, no repoint');
SELECT _assert_eq((SELECT base_external_id FROM topshot_moment_subeditions WHERE nft_id='52038411'), '1:1', 'NULL subedition, no repoint');
SELECT _assert_eq((SELECT count(*)::text FROM topshot_atlas_reconcile_log WHERE source='checkpoint'), '3', 'three logged repoints, all source checkpoint');
SELECT _assert_eq((SELECT count(*)::text FROM _runs WHERE pipeline='topshot-map-checkpoint-reconcile' AND ok), '2', 'every run logs ok');

-- 3) Past the newest record the next run wraps to the start and counts a sweep.
SELECT _assert_eq((SELECT (reconcile_topshot_map_with_checkpoint(1000, 2000))->>'slice_lo'), '52038407', 'wraps to the start');
SELECT _assert_eq((SELECT sweeps::text FROM topshot_checkpoint_reconcile_cursor), '1', 'a wrap counts a sweep');

SELECT '✓ reconcile_topshot_map_with_checkpoint invariants pass' AS result;
ROLLBACK;

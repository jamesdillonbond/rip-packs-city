-- DB invariant: public.name_pack_pulls_by_id_neighbours + public.refresh_topshot_moment_id_editions
-- (2026-09-29). Top Shot mints moments in batches (one edition, consecutive ids),
-- so a pull no record names takes its edition from its nearest known ids --
-- ONLY when both sides agree and each is within 50 ids (99.3 % right on 3,189
-- validation pulls; 81 % past 50). Claims:
--   N1 agreeing neighbours within 50 -> named, resolved_via = id_neighbours.
--   N2 neighbours that DISAGREE -> never named.
--   N3 an agreeing neighbour 51+ ids away -> never named.
--   N4 no neighbour above (a pack id pulled from a box, past every moment id) -> never named.
--   N5 a pull a record already named is never overwritten.
--   N6 pack_open_pull_values.n_inferred counts the inferred pulls and the pack is requeued to reprice.
--   R1 the corpus drops an id two sources disagree on.
--   R2 an EMPTY build never wipes the corpus (a failed read is not "no moments").
--   R3 an id no source names any more is deleted, after the write.
--
--   I1 (2026-09-29) an inferred name is re-derived each run: cleared when its
--      neighbours no longer agree, moved when they now agree on another edition.
--   S1 (2026-09-29) sales feed the corpus through topshot_sale_id_editions; an
--      id whose sales disagree is marked NULL for good and never enters it.
--
-- The function DDL below is VERBATIM from the committed migrations
-- (supabase/migrations/20260929130700_audit_20260929_topshot_pack_pulls_named_by_id_neighbours.sql,
--  supabase/migrations/20260929143000_audit_20260929_id_neighbour_corpus_reads_sales.sql,
--  supabase/migrations/20260929145500_audit_20260929_inferred_pull_names_rederived_each_run.sql).
-- __tests__/db-invariants-drift-guard.test.ts fails CI on drift.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE public.pipeline_runs_stub (pipeline text, ok boolean, rows_written int, extra jsonb);
CREATE FUNCTION public.log_pipeline_run(p_pipeline text, p_started_at timestamptz, p_rows_found int, p_rows_written int,
  p_rows_skipped int, p_ok boolean, p_error text, p_collection_slug text, p_cursor_before text, p_cursor_after text, p_extra jsonb)
RETURNS bigint LANGUAGE sql AS $$ INSERT INTO public.pipeline_runs_stub VALUES (p_pipeline, p_ok, p_rows_written, p_extra) RETURNING 1::bigint $$;

CREATE TABLE public.editions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), collection_id uuid, external_id text);
CREATE TABLE public.wallet_moments_cache (collection_id uuid, moment_id text, edition_key text);
CREATE TABLE public.moments (collection_id uuid, nft_id text, edition_id uuid);
CREATE TABLE public.topshot_ownership (nft_id text, edition_external_id text);
CREATE TABLE public.nft_edition_map (collection_id uuid, nft_id text, edition_external_id text);
CREATE TABLE public.pack_open_pulls (collection_id uuid, pack_nft_id text, nft_id text, opener_address text,
  edition_id uuid, resolved_via text, resolved_at timestamptz, local_checked_at timestamptz,
  PRIMARY KEY (collection_id, pack_nft_id, nft_id));
CREATE TABLE public.pack_open_pull_values (collection_id uuid, pack_nft_id text, opener_address text,
  n_pulls int, n_resolved int, n_priced int, pull_value_usd numeric, priced_at timestamptz,
  n_inferred int NOT NULL DEFAULT 0, PRIMARY KEY (collection_id, pack_nft_id));
CREATE TABLE public.sales (collection_id uuid, nft_id text, edition_id uuid, sold_at timestamptz);
CREATE TABLE public.topshot_sale_id_editions (id bigint PRIMARY KEY, edition_external_id text, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.topshot_moment_id_editions (id bigint PRIMARY KEY, edition_external_id text NOT NULL,
  refreshed_at timestamptz NOT NULL DEFAULT now());

-- >>> BEGIN verbatim (body byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.refresh_topshot_sale_id_editions(p_from timestamptz, p_to timestamptz)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '300s'
AS $function$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_ts constant uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_read int := 0; v_written int := 0;
BEGIN
  IF p_from IS NULL OR p_to IS NULL OR p_from >= p_to THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'p_from < p_to required');
  END IF;
  IF NOT pg_try_advisory_xact_lock(hashtext('refresh_topshot_sale_id_editions')) THEN
    RETURN jsonb_build_object('ok', true, 'skipped', 'another run holds the lock');
  END IF;

  WITH src AS (
    SELECT s.nft_id::bigint AS id, e.external_id AS ext
      FROM public.sales s
      JOIN public.editions e ON e.id = s.edition_id AND e.collection_id = v_ts
     WHERE s.collection_id = v_ts
       AND s.sold_at >= p_from AND s.sold_at < p_to
       AND s.nft_id ~ '^[0-9]{1,15}$'
       AND e.external_id ~ '^[0-9]+:[0-9]+(::[0-9]+)?$'
  ), g AS (
    SELECT id, CASE WHEN count(DISTINCT ext) = 1 THEN min(ext) END AS ext, count(*) AS n
      FROM src GROUP BY id
  ), up AS (
    INSERT INTO public.topshot_sale_id_editions AS t (id, edition_external_id, updated_at)
    SELECT id, ext, now() FROM g
    ON CONFLICT (id) DO UPDATE
      -- a disagreement, now or before, is final: NULL
      SET edition_external_id = CASE WHEN t.edition_external_id IS NOT DISTINCT FROM EXCLUDED.edition_external_id
                                     THEN t.edition_external_id END,
          updated_at = now()
      WHERE t.edition_external_id IS DISTINCT FROM EXCLUDED.edition_external_id
    RETURNING 1
  )
  SELECT (SELECT coalesce(sum(n), 0) FROM g), (SELECT count(*) FROM up) INTO v_read, v_written;

  PERFORM public.log_pipeline_run('topshot-sale-id-editions', v_started, v_read, v_written, 0, true, NULL,
    'nba_top_shot', p_from::text, p_to::text,
    jsonb_build_object('sales_read', v_read, 'ids_written', v_written));
  RETURN jsonb_build_object('ok', true, 'sales_read', v_read, 'ids_written', v_written);
END;
$function$;

CREATE OR REPLACE FUNCTION public.refresh_topshot_moment_id_editions()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '300s'
AS $function$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_ts constant uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_built int := 0; v_ins int := 0; v_upd int := 0; v_del int := 0;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('refresh_topshot_moment_id_editions')) THEN
    RETURN jsonb_build_object('ok', true, 'skipped', 'another run holds the lock');
  END IF;

  DROP TABLE IF EXISTS _tmie;  -- a second call in the same transaction
  CREATE TEMP TABLE _tmie ON COMMIT DROP AS
  SELECT u.id, min(u.ext) AS ext
  FROM (
    SELECT w.moment_id::bigint AS id, w.edition_key AS ext
      FROM public.wallet_moments_cache w
     WHERE w.collection_id = v_ts AND w.moment_id ~ '^[0-9]{1,15}$'
       AND w.edition_key ~ '^[0-9]+:[0-9]+(::[0-9]+)?$'
    UNION ALL
    SELECT m.nft_id::bigint, e.external_id
      FROM public.moments m JOIN public.editions e ON e.id = m.edition_id AND e.collection_id = v_ts
     WHERE m.collection_id = v_ts AND m.nft_id ~ '^[0-9]{1,15}$'
       AND e.external_id ~ '^[0-9]+:[0-9]+(::[0-9]+)?$'
    UNION ALL
    SELECT t.nft_id::bigint, t.edition_external_id
      FROM public.topshot_ownership t
     WHERE t.nft_id ~ '^[0-9]{1,15}$' AND t.edition_external_id ~ '^[0-9]+:[0-9]+(::[0-9]+)?$'
    UNION ALL
    SELECT n.nft_id::bigint, n.edition_external_id
      FROM public.nft_edition_map n
     WHERE n.collection_id = v_ts AND n.nft_id ~ '^[0-9]{1,15}$'
       AND n.edition_external_id ~ '^[0-9]+:[0-9]+(::[0-9]+)?$'
    UNION ALL
    -- 2026-09-29: every Top Shot moment id a recorded SALE names (4.17M ids
    -- with it, from 2.48M), kept by refresh_topshot_sale_id_editions(); an id
    -- whose sales disagree carries '!' and so drops out below
    SELECT s.id, coalesce(s.edition_external_id, '!')
      FROM public.topshot_sale_id_editions s
  ) u
  GROUP BY u.id
  HAVING count(DISTINCT u.ext) = 1 AND min(u.ext) <> '!';
  GET DIAGNOSTICS v_built = ROW_COUNT;

  -- A build that came back empty is a failed read, never "no moments": keep
  -- the table as it is.
  IF v_built = 0 THEN
    PERFORM public.log_pipeline_run('topshot-moment-id-editions', v_started, 0, 0, 0, false,
      'build returned 0 ids -- table left unchanged', 'nba_top_shot', NULL, NULL, '{}'::jsonb);
    RETURN jsonb_build_object('ok', false, 'reason', 'build returned 0 ids');
  END IF;

  INSERT INTO public.topshot_moment_id_editions (id, edition_external_id, refreshed_at)
  SELECT b.id, b.ext, now() FROM _tmie b
  ON CONFLICT (id) DO UPDATE SET edition_external_id = EXCLUDED.edition_external_id, refreshed_at = now()
    WHERE topshot_moment_id_editions.edition_external_id IS DISTINCT FROM EXCLUDED.edition_external_id;
  GET DIAGNOSTICS v_ins = ROW_COUNT;  -- new + changed

  -- written first; now delete only ids the build no longer names
  DELETE FROM public.topshot_moment_id_editions t
   WHERE NOT EXISTS (SELECT 1 FROM _tmie b WHERE b.id = t.id);
  GET DIAGNOSTICS v_del = ROW_COUNT;

  PERFORM public.log_pipeline_run('topshot-moment-id-editions', v_started, v_built, v_ins, 0, true, NULL,
    'nba_top_shot', NULL, NULL,
    jsonb_build_object('built', v_built, 'inserted_or_changed', v_ins, 'deleted', v_del));
  RETURN jsonb_build_object('ok', true, 'built', v_built, 'inserted_or_changed', v_ins, 'deleted', v_del);
END;
$function$;

CREATE OR REPLACE FUNCTION public.name_pack_pulls_by_id_neighbours()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '300s'
AS $function$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_ts constant uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_cand int := 0; v_named int := 0; v_packs int := 0; v_cleared int := 0;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('name_pack_pulls_by_id_neighbours')) THEN
    RETURN jsonb_build_object('ok', true, 'skipped', 'another run holds the lock');
  END IF;

  -- (0) 2026-09-29: an inference is only as good as the corpus it was drawn
  -- from. Re-derive every inferred name against today's corpus and clear the
  -- ones it no longer backs (neighbours now disagree / too far, or a record
  -- now names the id itself), so they are named again below or by a record.
  -- The corpus gaining sales moved 14 of 11,554 to another edition and left
  -- 47 unsupported.
  WITH inf AS MATERIALIZED (
    SELECT o.pack_nft_id, o.nft_id, o.nft_id::bigint AS id, e.external_id AS cur
      FROM public.pack_open_pulls o
      JOIN public.editions e ON e.id = o.edition_id
     WHERE o.collection_id = v_ts AND o.resolved_via = 'id_neighbours'
  ), chk AS (
    SELECT i.*, lo.id AS lo_id, lo.edition_external_id AS lo_ext, hi.id AS hi_id, hi.edition_external_id AS hi_ext,
           EXISTS (SELECT 1 FROM public.topshot_moment_id_editions x WHERE x.id = i.id) AS has_record
    FROM inf i
    LEFT JOIN LATERAL (
      SELECT t.id, t.edition_external_id FROM public.topshot_moment_id_editions t
       WHERE t.id < i.id ORDER BY t.id DESC LIMIT 1
    ) lo ON true
    LEFT JOIN LATERAL (
      SELECT t.id, t.edition_external_id FROM public.topshot_moment_id_editions t
       WHERE t.id > i.id ORDER BY t.id ASC LIMIT 1
    ) hi ON true
  ), stale AS (
    SELECT c.pack_nft_id, c.nft_id FROM chk c
     WHERE c.has_record
        OR NOT (coalesce(c.lo_ext = c.hi_ext, false)
                AND c.id - c.lo_id <= 50 AND c.hi_id - c.id <= 50
                AND c.lo_ext = c.cur)
  ), clr AS (
    UPDATE public.pack_open_pulls o
       SET edition_id = NULL, resolved_via = NULL, resolved_at = NULL, local_checked_at = NULL
      FROM stale s
     WHERE o.collection_id = v_ts AND o.pack_nft_id = s.pack_nft_id AND o.nft_id = s.nft_id
       AND o.resolved_via = 'id_neighbours'
    RETURNING o.pack_nft_id
  ), rq AS (
    UPDATE public.pack_open_pull_values v SET priced_at = '-infinity'
      FROM (SELECT DISTINCT pack_nft_id FROM clr) c
     WHERE v.collection_id = v_ts AND v.pack_nft_id = c.pack_nft_id
    RETURNING 1
  )
  SELECT count(*) INTO v_cleared FROM clr;

  SELECT count(*) INTO v_cand FROM public.pack_open_pulls
   WHERE collection_id = v_ts AND edition_id IS NULL AND nft_id ~ '^[0-9]{1,15}$';

  WITH cand AS MATERIALIZED (
    SELECT p.pack_nft_id, p.nft_id, p.nft_id::bigint AS id
    FROM public.pack_open_pulls p
    WHERE p.collection_id = v_ts AND p.edition_id IS NULL AND p.nft_id ~ '^[0-9]{1,15}$'
  ), pred AS (
    SELECT c.*, lo.id AS lo_id, lo.ext AS lo_ext, hi.id AS hi_id, hi.ext AS hi_ext
    FROM cand c
    LEFT JOIN LATERAL (
      SELECT t.id, t.edition_external_id AS ext FROM public.topshot_moment_id_editions t
       WHERE t.id < c.id ORDER BY t.id DESC LIMIT 1
    ) lo ON true
    LEFT JOIN LATERAL (
      SELECT t.id, t.edition_external_id AS ext FROM public.topshot_moment_id_editions t
       WHERE t.id > c.id ORDER BY t.id ASC LIMIT 1
    ) hi ON true
  ), named AS (
    -- both neighbours the SAME edition, each within 50 ids (99.3 % measured);
    -- the edition must exist in our catalogue
    SELECT p.pack_nft_id, p.nft_id, e.id AS edition_id
    FROM pred p
    JOIN public.editions e ON e.collection_id = v_ts AND e.external_id = p.lo_ext
    WHERE p.lo_ext = p.hi_ext
      AND p.id - p.lo_id <= 50
      AND p.hi_id - p.id <= 50
      -- an id a record names is the pull lane's to name, never inferred
      AND NOT EXISTS (SELECT 1 FROM public.topshot_moment_id_editions x WHERE x.id = p.id)
  ), upd AS (
    UPDATE public.pack_open_pulls o
       SET edition_id = n.edition_id, resolved_via = 'id_neighbours', resolved_at = now()
      FROM named n
     WHERE o.collection_id = v_ts AND o.pack_nft_id = n.pack_nft_id AND o.nft_id = n.nft_id
       AND o.edition_id IS NULL
    RETURNING o.pack_nft_id
  ), rq AS (
    -- a pack whose inferred name changed edition keeps the same n_inferred,
    -- so it is requeued here, not only by the count below
    UPDATE public.pack_open_pull_values v SET priced_at = '-infinity'
      FROM (SELECT DISTINCT pack_nft_id FROM upd) u
     WHERE v.collection_id = v_ts AND v.pack_nft_id = u.pack_nft_id
    RETURNING 1
  )
  SELECT count(*) INTO v_named FROM upd;

  -- every pack carrying an inferred name: keep n_inferred exact and queue a
  -- reprice where it changed
  WITH cnt AS (
    SELECT o.pack_nft_id, count(*) AS n
      FROM public.pack_open_pulls o
     WHERE o.collection_id = v_ts AND o.resolved_via = 'id_neighbours'
     GROUP BY o.pack_nft_id
  ), upd AS (
    UPDATE public.pack_open_pull_values v
       SET n_inferred = coalesce(c.n, 0), priced_at = '-infinity'
      FROM (SELECT v2.pack_nft_id, cnt.n
              FROM public.pack_open_pull_values v2
              LEFT JOIN cnt ON cnt.pack_nft_id = v2.pack_nft_id
             WHERE v2.collection_id = v_ts
               AND v2.n_inferred IS DISTINCT FROM coalesce(cnt.n, 0)) c
     WHERE v.collection_id = v_ts AND v.pack_nft_id = c.pack_nft_id
    RETURNING 1
  )
  SELECT count(*) INTO v_packs FROM upd;

  PERFORM public.log_pipeline_run('pack-pulls-id-neighbours', v_started, v_cand, v_named, v_cand - v_named, true, NULL,
    'nba_top_shot', NULL, NULL,
    jsonb_build_object('unnamed_candidates', v_cand, 'named', v_named, 'packs_requeued', v_packs, 'inferred_cleared', v_cleared));
  RETURN jsonb_build_object('ok', true, 'unnamed_candidates', v_cand, 'named', v_named, 'packs_requeued', v_packs,
                            'inferred_cleared', v_cleared);
END;
$function$;
-- <<< END verbatim <<<

-- editions: batch A (1:1) at ids 100..120, batch B (1:2) at 200..220; C (1:3) far away
INSERT INTO public.editions (collection_id, external_id) VALUES
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', '1:1'), ('95f28a17-224a-4025-96ad-adf8a4c63bfd', '1:2'),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', '1:3'), ('95f28a17-224a-4025-96ad-adf8a4c63bfd', '1:9');
-- corpus sources
INSERT INTO public.wallet_moments_cache VALUES
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', '100', '1:1'),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', '120', '1:1'),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', '150', '1:1'),   -- R1: ownership says 1:9 -> dropped
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', '500', '1:1'),   -- N2: 500 (1:1) and 520 (1:2) straddle 510
  ('dee28451-5d62-409e-a1ad-a83f763ac070', '110', '9:9');   -- another collection: never read
INSERT INTO public.topshot_ownership VALUES ('150', '1:9'), ('200', '1:2'), ('300', '1:3');
INSERT INTO public.nft_edition_map VALUES ('95f28a17-224a-4025-96ad-adf8a4c63bfd', '230', '1:2'),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', '520', '1:2'),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', '400', '1:3');
INSERT INTO public.moments (collection_id, nft_id, edition_id)
  SELECT '95f28a17-224a-4025-96ad-adf8a4c63bfd', '460', id FROM public.editions WHERE external_id = '1:3';
-- a stale corpus row no source names any more (R3)
INSERT INTO public.topshot_moment_id_editions VALUES (999, '1:1', now() - interval '2 days');

DO $$
DECLARE v jsonb;
BEGIN
  v := public.refresh_topshot_moment_id_editions();
  PERFORM _assert((v->>'ok')::boolean, 'refresh ok');
  PERFORM _assert(NOT EXISTS (SELECT 1 FROM public.topshot_moment_id_editions WHERE id = 150), 'R1 an id two sources disagree on is dropped');
  PERFORM _assert(NOT EXISTS (SELECT 1 FROM public.topshot_moment_id_editions WHERE id = 999), 'R3 an id no source names is deleted');
  PERFORM _assert((SELECT edition_external_id = '1:3' FROM public.topshot_moment_id_editions WHERE id = 460), 'moments rows are read through editions');
  PERFORM _assert_eq((SELECT count(*)::text FROM public.topshot_moment_id_editions), '9', '100 120 200 230 300 400 460 500 520');
END $$;

-- pulls
INSERT INTO public.pack_open_pulls (collection_id, pack_nft_id, nft_id, opener_address) VALUES
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'PK1', '110', '0xw'),   -- N1: 100 and 120 both 1:1
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'PK1', '125', '0xw'),   -- 120 (1:1) vs 200 (1:2), and 200 is 75 away
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'PK2', '510', '0xw'),   -- N2: 500 (1:1) vs 520 (1:2), both 10 away
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'PK2', '351', '0xw'),   -- N3: 300 and 400 agree (1:3) but 300 is 51 away
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'PK2', '280375467851224', '0xw'),  -- N4: a pack id, nothing above
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'PK3', '215', '0xw');   -- N1 again: 200 and 230 both 1:2
-- N5: a record-named pull between agreeing neighbours of ANOTHER edition keeps its name
INSERT INTO public.pack_open_pulls (collection_id, pack_nft_id, nft_id, opener_address, edition_id, resolved_via)
  SELECT '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'PK3', '105', '0xw', id, 'sales' FROM public.editions WHERE external_id = '1:9';
INSERT INTO public.pack_open_pull_values (collection_id, pack_nft_id, opener_address, n_pulls, n_resolved, n_priced, priced_at) VALUES
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'PK1', '0xw', 2, 0, 0, now()),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'PK2', '0xw', 2, 0, 0, now()),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'PK3', '0xw', 2, 1, 1, now());

DO $$
DECLARE v jsonb;
BEGIN
  v := public.name_pack_pulls_by_id_neighbours();
  PERFORM _assert_eq(v->>'named', '2', '110 and 215');
  PERFORM _assert((SELECT e.external_id = '1:1' AND o.resolved_via = 'id_neighbours' FROM public.pack_open_pulls o JOIN public.editions e ON e.id = o.edition_id WHERE o.nft_id = '110'),
                  'N1 110 sits between 100 and 120 (both 1:1) -> 1:1, labelled id_neighbours');
  PERFORM _assert((SELECT e.external_id = '1:2' FROM public.pack_open_pulls o JOIN public.editions e ON e.id = o.edition_id WHERE o.nft_id = '215'),
                  'N1 215 sits between 200 and 230 (both 1:2) -> 1:2');
  PERFORM _assert((SELECT edition_id IS NULL FROM public.pack_open_pulls WHERE nft_id = '125'), '125 neighbours disagree and one is far -> unnamed');
  PERFORM _assert((SELECT edition_id IS NULL FROM public.pack_open_pulls WHERE nft_id = '510'), 'N2 close neighbours that DISAGREE -> unnamed');
  PERFORM _assert((SELECT edition_id IS NULL FROM public.pack_open_pulls WHERE nft_id = '351'), 'N3 an agreeing neighbour 51 ids away -> unnamed');
  PERFORM _assert((SELECT edition_id IS NULL FROM public.pack_open_pulls WHERE nft_id = '280375467851224'), 'N4 a pack id past every moment id -> unnamed');
  PERFORM _assert((SELECT e.external_id = '1:9' AND o.resolved_via = 'sales' FROM public.pack_open_pulls o JOIN public.editions e ON e.id = o.edition_id WHERE o.nft_id = '105'),
                  'N5 a record-named pull is never overwritten');
  PERFORM _assert((SELECT n_inferred = 1 AND priced_at = '-infinity' FROM public.pack_open_pull_values WHERE pack_nft_id = 'PK1'), 'N6 PK1 1 inferred, requeued');
  PERFORM _assert((SELECT n_inferred = 1 AND priced_at = '-infinity' FROM public.pack_open_pull_values WHERE pack_nft_id = 'PK3'), 'N6 PK3 1 inferred, requeued');
  PERFORM _assert((SELECT n_inferred = 0 AND priced_at > '-infinity' FROM public.pack_open_pull_values WHERE pack_nft_id = 'PK2'), 'N6 PK2 nothing inferred, not requeued');
  -- idempotent: a second run names nothing and requeues nothing
  v := public.name_pack_pulls_by_id_neighbours();
  PERFORM _assert(v->>'named' = '0' AND v->>'packs_requeued' = '0', 'a second run is a no-op');
END $$;

-- I1: the corpus changes under two inferred names.
-- 112 (between 100 and 120, both 1:1) makes 110's neighbours 100 (1:1) / 112 (1:2) -> cleared.
-- 210 and 220 (both 1:3) now sit either side of 215 (was 1:2) -> renamed 1:3, PK3 requeued.
INSERT INTO public.wallet_moments_cache VALUES
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', '112', '1:2'),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', '210', '1:3'),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', '220', '1:3');
UPDATE public.pack_open_pull_values SET priced_at = now();
DO $$
DECLARE v jsonb;
BEGIN
  PERFORM public.refresh_topshot_moment_id_editions();
  v := public.name_pack_pulls_by_id_neighbours();
  PERFORM _assert_eq(v->>'inferred_cleared', '2', 'I1 both inferred names are re-derived and cleared');
  PERFORM _assert((SELECT edition_id IS NULL AND resolved_via IS NULL FROM public.pack_open_pulls WHERE nft_id = '110'),
                  'I1 110: neighbours now disagree -> unnamed again, never left standing');
  PERFORM _assert((SELECT e.external_id = '1:3' AND o.resolved_via = 'id_neighbours' FROM public.pack_open_pulls o JOIN public.editions e ON e.id = o.edition_id WHERE o.nft_id = '215'),
                  'I1 215: neighbours now agree on 1:3 -> renamed 1:3');
  PERFORM _assert((SELECT priced_at = '-infinity' FROM public.pack_open_pull_values WHERE pack_nft_id = 'PK3'), 'I1 PK3 (same n_inferred) is requeued to reprice');
  PERFORM _assert((SELECT priced_at = '-infinity' AND n_inferred = 0 FROM public.pack_open_pull_values WHERE pack_nft_id = 'PK1'), 'I1 PK1 lost its inferred name: requeued, n_inferred 0');
  v := public.name_pack_pulls_by_id_neighbours();
  PERFORM _assert(v->>'inferred_cleared' = '0' AND v->>'named' = '0', 'I1 a second run is stable');
END $$;

-- R2: an empty build leaves the corpus alone
DELETE FROM public.wallet_moments_cache; DELETE FROM public.topshot_ownership; DELETE FROM public.nft_edition_map; DELETE FROM public.moments;
DO $$
DECLARE v jsonb;
BEGIN
  v := public.refresh_topshot_moment_id_editions();
  PERFORM _assert(NOT (v->>'ok')::boolean, 'an empty build reports failure');
  PERFORM _assert_eq((SELECT count(*)::text FROM public.topshot_moment_id_editions), '12', 'R2 and wipes nothing');
  PERFORM _assert((SELECT NOT ok FROM public.pipeline_runs_stub WHERE pipeline = 'topshot-moment-id-editions' ORDER BY ctid DESC LIMIT 1), 'its pipeline row says ok = false');
END $$;

-- S1: sales feed the corpus; a conflicting id is excluded for good
INSERT INTO public.wallet_moments_cache VALUES ('95f28a17-224a-4025-96ad-adf8a4c63bfd', '100', '1:1');
INSERT INTO public.sales
  SELECT '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid, '700'::text, id, '2026-09-01'::timestamptz FROM public.editions WHERE external_id = '1:2'
  UNION ALL SELECT '95f28a17-224a-4025-96ad-adf8a4c63bfd', '701', id, '2026-09-01' FROM public.editions WHERE external_id = '1:2'
  UNION ALL SELECT '95f28a17-224a-4025-96ad-adf8a4c63bfd', '701', id, '2026-09-02' FROM public.editions WHERE external_id = '1:3'
  UNION ALL SELECT '95f28a17-224a-4025-96ad-adf8a4c63bfd', '702', id, '2025-01-01' FROM public.editions WHERE external_id = '1:2'
  UNION ALL SELECT 'dee28451-5d62-409e-a1ad-a83f763ac070', '703', id, '2026-09-01' FROM public.editions WHERE external_id = '1:2';
DO $$
DECLARE v jsonb;
BEGIN
  PERFORM _assert((public.refresh_topshot_sale_id_editions(now(), now() - interval '1 day'))->>'ok' = 'false', 'a backwards window is refused');
  v := public.refresh_topshot_sale_id_editions('2026-08-01', '2026-10-01');
  PERFORM _assert_eq(v->>'sales_read', '3', 'three Top Shot sales in the window (the 2025 one and the All Day one are not)');
  PERFORM _assert((SELECT edition_external_id = '1:2' FROM public.topshot_sale_id_editions WHERE id = 700), 'S1 700 -> 1:2');
  PERFORM _assert((SELECT edition_external_id IS NULL FROM public.topshot_sale_id_editions WHERE id = 701), 'S1 701 sold as 1:2 and 1:3 -> NULL');
  PERFORM _assert(NOT EXISTS (SELECT 1 FROM public.topshot_sale_id_editions WHERE id IN (702, 703)), 'outside the window / another collection: not read');
  -- a later window naming 700 differently makes it a conflict for good
  UPDATE public.sales SET sold_at = '2025-01-01' WHERE nft_id = '702';
  INSERT INTO public.sales SELECT '95f28a17-224a-4025-96ad-adf8a4c63bfd', '700', id, '2025-01-02' FROM public.editions WHERE external_id = '1:3';
  PERFORM public.refresh_topshot_sale_id_editions('2025-01-01', '2025-02-01');
  PERFORM _assert((SELECT edition_external_id IS NULL FROM public.topshot_sale_id_editions WHERE id = 700), 'S1 a later disagreement turns 700 NULL');
  PERFORM _assert((SELECT edition_external_id = '1:2' FROM public.topshot_sale_id_editions WHERE id = 702), 'S1 702 -> 1:2 from its own window');
  v := public.refresh_topshot_moment_id_editions();
  PERFORM _assert((SELECT edition_external_id = '1:2' FROM public.topshot_moment_id_editions WHERE id = 702), 'S1 a sale-named id enters the corpus');
  PERFORM _assert(NOT EXISTS (SELECT 1 FROM public.topshot_moment_id_editions WHERE id IN (700, 701)), 'S1 a conflicting sale id never enters it');
END $$;

ROLLBACK;

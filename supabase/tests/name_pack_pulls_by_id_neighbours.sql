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
-- The function DDL below is VERBATIM from the committed migration
-- (supabase/migrations/20260929130700_audit_20260929_topshot_pack_pulls_named_by_id_neighbours.sql).
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
  edition_id uuid, resolved_via text, resolved_at timestamptz, PRIMARY KEY (collection_id, pack_nft_id, nft_id));
CREATE TABLE public.pack_open_pull_values (collection_id uuid, pack_nft_id text, opener_address text,
  n_pulls int, n_resolved int, n_priced int, pull_value_usd numeric, priced_at timestamptz,
  n_inferred int NOT NULL DEFAULT 0, PRIMARY KEY (collection_id, pack_nft_id));
CREATE TABLE public.topshot_moment_id_editions (id bigint PRIMARY KEY, edition_external_id text NOT NULL,
  refreshed_at timestamptz NOT NULL DEFAULT now());

-- >>> BEGIN verbatim (body byte-identical to the migration) >>>
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
  ) u
  GROUP BY u.id
  HAVING count(DISTINCT u.ext) = 1;
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
  v_cand int := 0; v_named int := 0; v_packs int := 0;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('name_pack_pulls_by_id_neighbours')) THEN
    RETURN jsonb_build_object('ok', true, 'skipped', 'another run holds the lock');
  END IF;

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
  ), upd AS (
    UPDATE public.pack_open_pulls o
       SET edition_id = n.edition_id, resolved_via = 'id_neighbours', resolved_at = now()
      FROM named n
     WHERE o.collection_id = v_ts AND o.pack_nft_id = n.pack_nft_id AND o.nft_id = n.nft_id
       AND o.edition_id IS NULL
    RETURNING o.pack_nft_id
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
    jsonb_build_object('unnamed_candidates', v_cand, 'named', v_named, 'packs_requeued', v_packs));
  RETURN jsonb_build_object('ok', true, 'unnamed_candidates', v_cand, 'named', v_named, 'packs_requeued', v_packs);
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

-- R2: an empty build leaves the corpus alone
DELETE FROM public.wallet_moments_cache; DELETE FROM public.topshot_ownership; DELETE FROM public.nft_edition_map; DELETE FROM public.moments;
DO $$
DECLARE v jsonb;
BEGIN
  v := public.refresh_topshot_moment_id_editions();
  PERFORM _assert(NOT (v->>'ok')::boolean, 'an empty build reports failure');
  PERFORM _assert_eq((SELECT count(*)::text FROM public.topshot_moment_id_editions), '9', 'R2 and wipes nothing');
  PERFORM _assert((SELECT NOT ok FROM public.pipeline_runs_stub WHERE pipeline = 'topshot-moment-id-editions' ORDER BY ctid DESC LIMIT 1), 'its pipeline row says ok = false');
END $$;

ROLLBACK;

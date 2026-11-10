-- DB invariant: public.heal_wmc_player_names_from_catalog(int) — #221 (2026-11-08; walk 2026-11-09).
-- The property: a wallet_moments_cache row's player_name becomes the name of the PERSON its edition
-- is linked to (players.name via editions.player_id, same collection) — never the edition's LABEL
-- text when the two differ. A Team Moment (player_id NULL), a Pinnacle row, a moment whose edition
-- key belongs to another collection, and a link into another collection are never touched;
-- p_limit bounds a call's writes and a CAPPED call does not advance the cursor; the run log counts
-- rows actually written; a full pass ends with the cursor reset and `passes` + 1; a second pass
-- writes nothing.
--
-- 2026-11-09: one call reads a bounded slice of editions behind wmc_player_name_heal_cursor (the
-- whole-table candidate scan timed out after the Candy census grew the table to 3.6M rows).
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20261110000023_audit_20261109_wmc_player_names_heal_walks_a_bounded_slice.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts from it.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE public.players (id uuid PRIMARY KEY, collection_id uuid, name text);
CREATE TABLE public.editions (collection_id uuid, external_id text, player_name text, player_id uuid);
CREATE TABLE public.wallet_moments_cache (id bigserial PRIMARY KEY, collection_id uuid, edition_key text, player_name text);
CREATE TABLE public.pipeline_runs_stub (pipeline text, rows_written int, ok boolean, extra jsonb);
CREATE FUNCTION public.log_pipeline_run(p_pipeline text, p_started_at timestamptz, p_rows_found int, p_rows_written int,
  p_rows_skipped int, p_ok boolean, p_error text, p_collection_slug text, p_cursor_before text, p_cursor_after text, p_extra jsonb)
RETURNS bigint LANGUAGE sql AS $$ INSERT INTO public.pipeline_runs_stub VALUES (p_pipeline, p_rows_written, p_ok, p_extra) RETURNING 1::bigint $$;
CREATE TABLE public.wmc_player_name_heal_cursor (
  id         integer PRIMARY KEY CHECK (id = 1),
  last_key   text NOT NULL DEFAULT '',
  last_coll  uuid,
  passes     integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.wmc_player_name_heal_cursor (id) VALUES (1);

-- A full pass: call until the walk restarts; returns total rewrites.
CREATE FUNCTION pg_temp.drain(p_limit int) RETURNS int LANGUAGE plpgsql AS $$
DECLARE v jsonb; t int := 0; i int := 0;
BEGIN
  LOOP
    i := i + 1;
    IF i > 100 THEN RAISE EXCEPTION 'the walk never restarted'; END IF;
    v := public.heal_wmc_player_names_from_catalog(p_limit);
    t := t + coalesce((v->>'rewrites')::int, 0);
    EXIT WHEN (v->>'pass_restarted')::boolean IS TRUE;
  END LOOP;
  RETURN t;
END $$;

-- >>> BEGIN verbatim heal_wmc_player_names_from_catalog (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.heal_wmc_player_names_from_catalog(p_limit integer DEFAULT 50000)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_started    timestamptz := clock_timestamp();
  v_pin        constant uuid := '7dd9dd11-e8b6-45c4-ac99-71331f959714';
  v_row_budget constant integer := 20000;
  v_cap        integer := greatest(coalesce(p_limit, 50000), 0);
  v_from_key   text;
  v_from_coll  uuid;
  v_keys       text[];
  v_colls      uuid[];
  v_rows_seen  bigint;
  v_n          int := 0;
BEGIN
  SELECT last_key, last_coll INTO v_from_key, v_from_coll
    FROM public.wmc_player_name_heal_cursor WHERE id = 1 FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO public.wmc_player_name_heal_cursor (id) VALUES (1);
    v_from_key := ''; v_from_coll := NULL;
  END IF;

  -- The next keys in (external_id, collection_id) order, taken while the running wmc row count
  -- stays under the budget. The first key is always taken, however many rows it holds.
  SELECT array_agg(k ORDER BY k, c), array_agg(c ORDER BY k, c), max(cum)
    INTO v_keys, v_colls, v_rows_seen
    FROM (
      SELECT k, c, n, sum(n) OVER (ORDER BY k, c) AS cum
        FROM (
          SELECT e.external_id::text AS k, e.collection_id AS c,
                 (SELECT count(*) FROM public.wallet_moments_cache w
                   WHERE w.collection_id = e.collection_id AND w.edition_key = e.external_id) AS n
            FROM public.editions e
            JOIN public.players p ON p.id = e.player_id AND p.collection_id = e.collection_id
           WHERE e.collection_id <> v_pin
             AND p.name IS NOT NULL AND btrim(p.name) <> ''
             AND (v_from_coll IS NULL AND e.external_id::text > v_from_key
                  OR (e.external_id::text, e.collection_id) > (v_from_key, v_from_coll))
           ORDER BY e.external_id, e.collection_id
           LIMIT 500
        ) a
    ) q
   WHERE q.cum - q.n < v_row_budget;

  IF v_keys IS NULL THEN
    -- End of a pass: start again from the top on the next call.
    UPDATE public.wmc_player_name_heal_cursor
       SET last_key = '', last_coll = NULL, passes = passes + 1, updated_at = now()
     WHERE id = 1;
    PERFORM public.log_pipeline_run(
      'wmc-player-names-follow-catalog', v_started,
      0, 0, 0,
      true, NULL, NULL, v_from_key, '',
      jsonb_build_object('rewrites', 0, 'target', 'linked_person', 'limit', p_limit, 'pass_restarted', true));
    RETURN jsonb_build_object('ok', true, 'rewrites', 0, 'pass_restarted', true);
  END IF;

  WITH k AS (
    SELECT unnest(v_keys) AS k, unnest(v_colls) AS c
  ), cand AS (
    SELECT w.id, p.name AS person_name
      FROM k
      JOIN public.editions e ON e.external_id = k.k AND e.collection_id = k.c
      JOIN public.players p ON p.id = e.player_id AND p.collection_id = e.collection_id
      JOIN public.wallet_moments_cache w ON w.collection_id = k.c AND w.edition_key = k.k
     WHERE w.player_name IS DISTINCT FROM p.name
     LIMIT v_cap
  ), upd AS (
    UPDATE public.wallet_moments_cache w
       SET player_name = c.person_name
      FROM cand c
     WHERE w.id = c.id
    RETURNING 1
  )
  SELECT count(*) INTO v_n FROM upd;

  -- A call that hit p_limit leaves the cursor where it was: the same keys are re-read next call
  -- and finished. Otherwise the cursor moves past the last key read.
  IF v_n < v_cap THEN
    UPDATE public.wmc_player_name_heal_cursor
       SET last_key = v_keys[array_length(v_keys, 1)],
           last_coll = v_colls[array_length(v_colls, 1)],
           updated_at = now()
     WHERE id = 1;
  END IF;

  -- rows_written = rows actually updated (RETURNING), never the candidate count.
  PERFORM public.log_pipeline_run(
    'wmc-player-names-follow-catalog', v_started,
    v_n, v_n, 0,
    true, NULL, NULL, v_from_key, v_keys[array_length(v_keys, 1)],
    jsonb_build_object('rewrites', v_n, 'target', 'linked_person', 'limit', p_limit,
                       'keys', array_length(v_keys, 1), 'rows_read', v_rows_seen,
                       'capped', v_n >= v_cap));

  RETURN jsonb_build_object('ok', true, 'rewrites', v_n, 'keys', array_length(v_keys, 1));
END
$function$;
-- <<< END verbatim heal_wmc_player_names_from_catalog <<<

INSERT INTO public.players VALUES
  ('00000000-0000-0000-0000-000000000001', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'Nic Claxton'),
  ('00000000-0000-0000-0000-000000000002', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'Jimmy Butler III'),
  ('00000000-0000-0000-0000-000000000003', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'Aleksej Pokusevski'),
  ('00000000-0000-0000-0000-000000000004', 'dee28451-5d62-409e-a1ad-a83f763ac070', 'Patrick Mahomes'),
  ('00000000-0000-0000-0000-000000000005', 'dee28451-5d62-409e-a1ad-a83f763ac070', 'Josh Hines-Allen'),
  ('00000000-0000-0000-0000-000000000006', 'dee28451-5d62-409e-a1ad-a83f763ac070', 'Elsewhere Person');
INSERT INTO public.editions VALUES
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', '1:1', 'Nic Claxton', '00000000-0000-0000-0000-000000000001'),              -- label = person; wmc lags (old alias spelling)
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', '1:2', 'Jimmy Butler', '00000000-0000-0000-0000-000000000002'),             -- label lags the person
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', '1:3', 'Aleksej Pokusevski', '00000000-0000-0000-0000-000000000003'),       -- accent: the person row decides
  ('dee28451-5d62-409e-a1ad-a83f763ac070', 'AD1', 'Patrick Mahomes II', '00000000-0000-0000-0000-000000000004'),       -- wmc and label agree, person differs
  ('dee28451-5d62-409e-a1ad-a83f763ac070', 'AD2', 'Josh Allen', '00000000-0000-0000-0000-000000000005'),               -- namesake label, linked to the right person
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', '1:4', 'Portland Trail Blazers', NULL),        -- Team Moment: no person
  ('7dd9dd11-e8b6-45c4-ac99-71331f959714', 'PIN1', 'Mickey Mouse', NULL),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', '1:5', 'Cross Link', '00000000-0000-0000-0000-000000000006'),               -- link into ANOTHER collection: ignored
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', '1:6', 'Nic Claxton', '00000000-0000-0000-0000-000000000001');              -- second row for the limit test
INSERT INTO public.wallet_moments_cache (collection_id, edition_key, player_name) VALUES
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', '1:1', 'Nicolas Claxton'),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', '1:2', 'Jimmy Butler'),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', '1:3', 'Aleksej Pokuševski'),
  ('dee28451-5d62-409e-a1ad-a83f763ac070', 'AD1', 'Patrick Mahomes II'),
  ('dee28451-5d62-409e-a1ad-a83f763ac070', 'AD2', 'Josh Allen'),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', '1:4', 'Team Moment'),
  ('7dd9dd11-e8b6-45c4-ac99-71331f959714', 'PIN1', 'mickey mouse'),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', '1:5', 'Cross Link'),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', '1:6', 'Nicolas Claxton'),
  ('dee28451-5d62-409e-a1ad-a83f763ac070', '1:1', 'Nicolas Claxton'),                    -- same key, OTHER collection, no edition there
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', '1:2', 'Jimmy Butler III');                   -- already right: not a candidate

DO $$
DECLARE v jsonb; c record;
BEGIN
  -- A capped call writes p_limit rows and leaves the cursor where it was.
  v := public.heal_wmc_player_names_from_catalog(1);
  PERFORM _assert_eq(v->>'rewrites', '1', 'p_limit 1 writes one row');
  SELECT * INTO c FROM public.wmc_player_name_heal_cursor WHERE id = 1;
  PERFORM _assert(c.last_key = '' AND c.last_coll IS NULL, '⚠ a CAPPED call does not advance the cursor');

  PERFORM _assert_eq(pg_temp.drain(50000)::text, '5', 'the rest of the pass rewrites the remaining five');
  SELECT * INTO c FROM public.wmc_player_name_heal_cursor WHERE id = 1;
  PERFORM _assert(c.passes = 1 AND c.last_key = '' AND c.last_coll IS NULL, 'a finished pass resets the cursor and counts the pass');

  PERFORM _assert((SELECT count(*) = 2 FROM public.wallet_moments_cache WHERE collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd' AND player_name = 'Nic Claxton'),
                  'an old spelling takes the person''s name (both rows)');
  PERFORM _assert((SELECT count(*) = 2 FROM public.wallet_moments_cache WHERE edition_key = '1:2' AND player_name = 'Jimmy Butler III'),
                  '⚠ the PERSON, not the edition label ("Jimmy Butler")');
  PERFORM _assert((SELECT player_name = 'Aleksej Pokusevski' FROM public.wallet_moments_cache WHERE edition_key = '1:3'), 'an accent variant follows the person row');
  PERFORM _assert((SELECT player_name = 'Patrick Mahomes' FROM public.wallet_moments_cache WHERE edition_key = 'AD1'), 'label and cache agreeing is not enough: the person wins');
  PERFORM _assert((SELECT player_name = 'Josh Hines-Allen' FROM public.wallet_moments_cache WHERE edition_key = 'AD2'), 'a namesake label shows the linked person');
  PERFORM _assert((SELECT player_name = 'Team Moment' FROM public.wallet_moments_cache WHERE edition_key = '1:4'), 'a Team Moment (no person) is untouched');
  PERFORM _assert((SELECT player_name = 'mickey mouse' FROM public.wallet_moments_cache WHERE edition_key = 'PIN1'), 'Pinnacle untouched');
  PERFORM _assert((SELECT player_name = 'Cross Link' FROM public.wallet_moments_cache WHERE edition_key = '1:5'), 'a link into another collection is ignored');
  PERFORM _assert((SELECT player_name = 'Nicolas Claxton' FROM public.wallet_moments_cache WHERE collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070' AND edition_key = '1:1'),
                  'an edition_key matches only WITHIN its collection');
  PERFORM _assert((SELECT bool_and(ok) FROM public.pipeline_runs_stub), 'every call logged ok');
  PERFORM _assert((SELECT sum(rows_written) = 6 FROM public.pipeline_runs_stub), 'the run log counts rows WRITTEN (1 + 5)');

  PERFORM _assert_eq(pg_temp.drain(50000)::text, '0', 'a second pass writes nothing');
  PERFORM _assert((SELECT passes = 2 FROM public.wmc_player_name_heal_cursor WHERE id = 1), 'the second pass is counted');
END $$;

ROLLBACK;

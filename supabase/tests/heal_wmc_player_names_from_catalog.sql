-- DB invariant: public.heal_wmc_player_names_from_catalog(int) — #221 (2026-11-08, second pass).
-- The property: a wallet_moments_cache row's player_name becomes the name of the PERSON its edition
-- is linked to (players.name via editions.player_id, same collection) — never the edition's LABEL
-- text when the two differ. A Team Moment (player_id NULL), a Pinnacle row, a moment whose edition
-- key belongs to another collection, and a link into another collection are never touched;
-- p_limit bounds a run; the run log counts rows actually written; a second run writes nothing.
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20261108191632_audit_20261108_wmc_player_names_follow_the_linked_person.sql);
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

-- >>> BEGIN verbatim heal_wmc_player_names_from_catalog (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.heal_wmc_player_names_from_catalog(p_limit integer DEFAULT 50000)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_pin     constant uuid := '7dd9dd11-e8b6-45c4-ac99-71331f959714';
  v_n       int := 0;
BEGIN
  WITH cand AS (
    SELECT w.id, p.name AS person_name
      FROM public.wallet_moments_cache w
      JOIN public.editions e
        ON e.collection_id = w.collection_id AND e.external_id = w.edition_key
      JOIN public.players p
        ON p.id = e.player_id AND p.collection_id = w.collection_id
     WHERE w.collection_id <> v_pin
       AND p.name IS NOT NULL AND btrim(p.name) <> ''
       AND w.player_name IS DISTINCT FROM p.name
     LIMIT greatest(coalesce(p_limit, 50000), 0)
  ), upd AS (
    UPDATE public.wallet_moments_cache w
       SET player_name = c.person_name
      FROM cand c
     WHERE w.id = c.id
    RETURNING 1
  )
  SELECT count(*) INTO v_n FROM upd;

  -- rows_written = rows actually updated (RETURNING), never the candidate count.
  PERFORM public.log_pipeline_run(
    'wmc-player-names-follow-catalog', v_started,
    v_n, v_n, 0,
    true, NULL, NULL, NULL, NULL,
    jsonb_build_object('rewrites', v_n, 'target', 'linked_person', 'limit', p_limit));

  RETURN jsonb_build_object('ok', true, 'rewrites', v_n);
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
DECLARE v jsonb;
BEGIN
  v := public.heal_wmc_player_names_from_catalog(1);
  PERFORM _assert_eq(v->>'rewrites', '1', 'p_limit 1 writes one row');

  v := public.heal_wmc_player_names_from_catalog(50000);
  PERFORM _assert_eq(v->>'rewrites', '5', 'the remaining five rewrites');
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
  PERFORM _assert((SELECT rows_written = 5 AND ok FROM public.pipeline_runs_stub ORDER BY ctid DESC LIMIT 1), 'the run log counts rows WRITTEN');

  v := public.heal_wmc_player_names_from_catalog(50000);
  PERFORM _assert_eq(v->>'rewrites', '0', 'a second run writes nothing');
END $$;

ROLLBACK;

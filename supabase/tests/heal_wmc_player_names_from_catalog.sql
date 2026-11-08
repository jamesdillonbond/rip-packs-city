-- DB invariant: public.heal_wmc_player_names_from_catalog(int) — #221, 2026-11-08.
-- The property: a wallet_moments_cache row's player_name is rewritten to the catalog
-- (editions.player_name) ONLY when the cached spelling is a registered alias of that
-- catalog player, or differs only by case / outer whitespace. An accent-only variant,
-- an unrelated name, "Team Moment" and a Pinnacle row are never touched; p_limit bounds a
-- run; the run log counts rows actually written.
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20261108171307_audit_20261108_wmc_player_names_follow_the_catalog.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts from it.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

-- CI's Postgres has no `extensions` schema (Supabase installs unaccent there); create it
-- first, as supabase/tests/norm_player.sql does.
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA extensions;

CREATE TABLE public.editions (collection_id uuid, external_id text, player_name text);
CREATE TABLE public.wallet_moments_cache (id bigserial PRIMARY KEY, collection_id uuid, edition_key text, player_name text);
CREATE TABLE public.players (id uuid PRIMARY KEY, collection_id uuid, name text);
CREATE TABLE public.player_name_aliases (collection_id uuid, alias_slug text, player_id uuid);
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
  v_alias   int := 0;
  v_case    int := 0;
BEGIN
  WITH cand AS (
    SELECT w.id, e.player_name AS cat_name,
           (lower(btrim(w.player_name)) = lower(btrim(e.player_name))) AS case_only
      FROM public.wallet_moments_cache w
      JOIN public.editions e
        ON e.collection_id = w.collection_id AND e.external_id = w.edition_key
     WHERE w.collection_id <> v_pin
       AND w.player_name IS NOT NULL
       AND e.player_name IS NOT NULL AND btrim(e.player_name) <> ''
       AND w.player_name <> e.player_name
       AND (lower(btrim(w.player_name)) = lower(btrim(e.player_name))
            OR EXISTS (SELECT 1
                         FROM public.player_name_aliases a
                         JOIN public.players p ON p.id = a.player_id
                        WHERE a.collection_id = e.collection_id
                          AND p.collection_id = e.collection_id
                          AND p.name = e.player_name
                          AND btrim(a.alias_slug, '-') =
                              btrim(regexp_replace(lower(btrim(extensions.unaccent(w.player_name))), '[^a-z0-9]+', '-', 'g'), '-')))
     LIMIT greatest(coalesce(p_limit, 50000), 0)
  ), upd AS (
    UPDATE public.wallet_moments_cache w
       SET player_name = c.cat_name
      FROM cand c
     WHERE w.id = c.id
    RETURNING c.case_only
  )
  SELECT count(*) FILTER (WHERE NOT case_only), count(*) FILTER (WHERE case_only)
    INTO v_alias, v_case
    FROM upd;

  -- rows_written = rows actually updated (RETURNING), never the candidate count.
  PERFORM public.log_pipeline_run(
    'wmc-player-names-follow-catalog', v_started,
    v_alias + v_case, v_alias + v_case, 0,
    true, NULL, NULL, NULL, NULL,
    jsonb_build_object('alias_rewrites', v_alias, 'case_space_rewrites', v_case, 'limit', p_limit));

  RETURN jsonb_build_object('ok', true, 'alias_rewrites', v_alias, 'case_space_rewrites', v_case);
END
$function$;
-- <<< END verbatim heal_wmc_player_names_from_catalog <<<

INSERT INTO public.players VALUES
  ('00000000-0000-0000-0000-000000000001', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'Nic Claxton'),
  ('00000000-0000-0000-0000-000000000002', 'dee28451-5d62-409e-a1ad-a83f763ac070', 'John Metchie III');
INSERT INTO public.player_name_aliases VALUES
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'nicolas-claxton', '00000000-0000-0000-0000-000000000001'),
  ('dee28451-5d62-409e-a1ad-a83f763ac070', 'john-metchie', '00000000-0000-0000-0000-000000000002');
INSERT INTO public.editions VALUES
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', '1:1', 'Nic Claxton'),
  ('dee28451-5d62-409e-a1ad-a83f763ac070', 'AD1', 'John Metchie III'),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', '1:2', 'DeMar DeRozan'),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', '1:3', 'Goran Dragić'),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', '1:4', 'Aleksej Pokusevski'),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', '1:5', 'Jimmy Butler'),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', '1:6', 'Portland Trail Blazers'),
  ('7dd9dd11-e8b6-45c4-ac99-71331f959714', 'PIN1', 'Mickey Mouse'),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', '1:7', 'Nic Claxton');
INSERT INTO public.wallet_moments_cache (collection_id, edition_key, player_name) VALUES
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', '1:1', 'Nicolas Claxton'),      -- alias -> rewrite
  ('dee28451-5d62-409e-a1ad-a83f763ac070', 'AD1', 'John Metchie'),         -- alias -> rewrite
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', '1:2', 'Demar DeRozan'),        -- case only -> rewrite
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', '1:3', 'Goran Dragić '),        -- trailing space -> rewrite
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', '1:4', 'Aleksej Pokuševski'),   -- accent only -> KEEP
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', '1:5', 'Jimmy Butler III'),     -- no alias -> KEEP
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', '1:6', 'Team Moment'),          -- KEEP
  ('7dd9dd11-e8b6-45c4-ac99-71331f959714', 'PIN1', 'mickey mouse'),       -- Pinnacle -> KEEP
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', '1:7', 'Nicolas Claxton'),      -- alias, second row (limit test)
  ('dee28451-5d62-409e-a1ad-a83f763ac070', '1:1', 'Nicolas Claxton');      -- same key, OTHER collection, no edition -> KEEP

DO $$
DECLARE v jsonb;
BEGIN
  v := public.heal_wmc_player_names_from_catalog(1);
  PERFORM _assert_eq(((v->>'alias_rewrites')::int + (v->>'case_space_rewrites')::int)::text, '1', 'p_limit 1 writes one row');

  v := public.heal_wmc_player_names_from_catalog(50000);
  PERFORM _assert_eq(((v->>'alias_rewrites')::int + (v->>'case_space_rewrites')::int)::text, '4', 'the remaining four rewrites');
  PERFORM _assert((SELECT count(*) = 2 FROM public.wallet_moments_cache WHERE player_name = 'Nic Claxton' AND collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'),
                  'a registered alias takes the catalog name (both rows)');
  PERFORM _assert((SELECT player_name = 'John Metchie III' FROM public.wallet_moments_cache WHERE edition_key = 'AD1'), 'All Day alias too');
  PERFORM _assert((SELECT player_name = 'DeMar DeRozan' FROM public.wallet_moments_cache WHERE edition_key = '1:2'), 'a case-only variant takes the catalog case');
  PERFORM _assert((SELECT player_name = 'Goran Dragić' FROM public.wallet_moments_cache WHERE edition_key = '1:3'), 'a trailing space is dropped');
  PERFORM _assert((SELECT player_name = 'Aleksej Pokuševski' FROM public.wallet_moments_cache WHERE edition_key = '1:4'), 'an accent-only variant is NOT rewritten (#221: diacritics are wrong both ways)');
  PERFORM _assert((SELECT player_name = 'Jimmy Butler III' FROM public.wallet_moments_cache WHERE edition_key = '1:5'), 'no alias: untouched');
  PERFORM _assert((SELECT player_name = 'Team Moment' FROM public.wallet_moments_cache WHERE edition_key = '1:6'), 'Team Moment untouched');
  PERFORM _assert((SELECT player_name = 'mickey mouse' FROM public.wallet_moments_cache WHERE edition_key = 'PIN1'), 'Pinnacle untouched');
  PERFORM _assert((SELECT player_name = 'Nicolas Claxton' FROM public.wallet_moments_cache WHERE collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070' AND edition_key = '1:1'),
                  'an edition_key matches only WITHIN its collection');
  PERFORM _assert((SELECT rows_written = 4 AND ok FROM public.pipeline_runs_stub ORDER BY ctid DESC LIMIT 1), 'the run log counts rows WRITTEN');

  v := public.heal_wmc_player_names_from_catalog(50000);
  PERFORM _assert_eq(((v->>'alias_rewrites')::int + (v->>'case_space_rewrites')::int)::text, '0', 'a second run writes nothing');
END $$;

ROLLBACK;

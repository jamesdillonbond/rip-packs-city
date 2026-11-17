-- DB invariant: public.resolve_ufc_edition_by_studio_meta — resolves a UFC Strike
-- sale to its edition from the two facts a studio-history row carries: the
-- athlete name and the edition size (circulation). Edition resolution is the
-- FMV-poisoning boundary — a wrong match attaches a sale to the wrong edition and
-- corrupts that edition's price history — so the match must be exact on BOTH keys
-- (case/whitespace-insensitive athlete AND exact circulation) and scoped to the
-- UFC collection. It returns a single edition id or NULL.
--
-- The function DDL below is VERBATIM from the committed migration's CREATE
-- (supabase/migrations/20260625040127_ufc_studio_history_resolver_and_targets.sql).
-- A later migration ALTERed its search_path, so live's header carries
-- `SET search_path` the CREATE does not; the BODY is byte-identical to live
-- (verified via pg_get_functiondef on 2026-07-31). The drift guard compares this
-- copy to the migration's CREATE (both repo-side), so the header match holds.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE public.editions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  collection_id     uuid,
  player_name       text,
  circulation_count integer
);

-- >>> BEGIN verbatim resolve_ufc_edition_by_studio_meta (body byte-identical to prod) >>>
CREATE OR REPLACE FUNCTION public.resolve_ufc_edition_by_studio_meta(p_athlete text, p_edition_size bigint)
 RETURNS uuid
 LANGUAGE sql
 STABLE
AS $function$
  SELECT e.id
  FROM public.editions e
  WHERE e.collection_id = '9b4824a8-736d-4a96-b450-8dcc0c46b023'
    AND lower(btrim(e.player_name)) = lower(btrim(p_athlete))
    AND e.circulation_count = p_edition_size
  LIMIT 1
$function$;
-- <<< END verbatim resolve_ufc_edition_by_studio_meta <<<

\set ufc '''9b4824a8-736d-4a96-b450-8dcc0c46b023'''
\set ts  '''95f28a17-224a-4025-96ad-adf8a4c63bfd'''

INSERT INTO public.editions (id, collection_id, player_name, circulation_count) VALUES
  ('11111111-1111-1111-1111-111111111111', :ufc::uuid, 'Conor McGregor', 500),
  ('22222222-2222-2222-2222-222222222222', :ufc::uuid, 'Conor McGregor', 250),   -- same athlete, different size
  ('33333333-3333-3333-3333-333333333333', :ts::uuid,  'Conor McGregor', 500);   -- same name+size, WRONG collection

-- ── Exact athlete + size resolves to the one UFC edition ────────────────────
SELECT _assert_eq(
  public.resolve_ufc_edition_by_studio_meta('Conor McGregor', 500)::text,
  '11111111-1111-1111-1111-111111111111',
  'exact athlete + edition size resolves to the matching UFC edition');

-- ── Athlete match is case- AND whitespace-insensitive (lower(btrim(...))) ────
SELECT _assert_eq(
  public.resolve_ufc_edition_by_studio_meta('  cOnOr mcGREGOR  ', 500)::text,
  '11111111-1111-1111-1111-111111111111',
  'athlete match ignores case and leading/trailing whitespace (lower + btrim)');

-- ── The edition SIZE is part of the key: 250 picks the other edition ────────
SELECT _assert_eq(
  public.resolve_ufc_edition_by_studio_meta('Conor McGregor', 250)::text,
  '22222222-2222-2222-2222-222222222222',
  'the circulation size disambiguates two editions of the same athlete');

-- ── A size with no matching edition returns NULL (never a wrong-size match) ──
SELECT _assert(
  public.resolve_ufc_edition_by_studio_meta('Conor McGregor', 999) IS NULL,
  'no edition of that exact size → NULL, never a fuzzy fallback');

-- ── Collection SCOPING: a same-name+size TopShot edition is never returned ──
SELECT _assert(
  public.resolve_ufc_edition_by_studio_meta('Conor McGregor', 500)
    <> '33333333-3333-3333-3333-333333333333',
  'resolution is scoped to the UFC collection — a same-name TopShot edition is excluded');

-- ── An unknown athlete returns NULL ─────────────────────────────────────────
SELECT _assert(
  public.resolve_ufc_edition_by_studio_meta('Nobody At All', 500) IS NULL,
  'an unknown athlete resolves to NULL');

SELECT '✓ resolve_ufc_edition_by_studio_meta invariants pass' AS result;
ROLLBACK;

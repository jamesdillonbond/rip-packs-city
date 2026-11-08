-- DB invariant: public.pinnacle_minted_renders_missing_from_catalog(int, int) — 2026-11-08.
-- The property: every render_id in RPC's mint records with no pinnacle_catalog row is counted
-- (with its pins), RECENT ones (first minted within p_recent_days) separately, a catalogued render
-- is never counted, a NULL render_id is ignored, and the sample is newest-first and bounded.
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20261108181134_audit_20261108_pinnacle_minted_renders_missing_from_catalog.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts from it.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE public.pinnacle_mint_events (nft_id text PRIMARY KEY, render_id text, minted_at timestamptz);
CREATE TABLE public.pinnacle_catalog (render_id text PRIMARY KEY);

-- >>> BEGIN verbatim pinnacle_minted_renders_missing_from_catalog (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.pinnacle_minted_renders_missing_from_catalog(p_sample integer DEFAULT 10, p_recent_days integer DEFAULT 14)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH missing AS (
    SELECT m.render_id, count(*)::int AS pins, min(m.minted_at) AS first_minted_at
      FROM public.pinnacle_mint_events m
     WHERE m.render_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM public.pinnacle_catalog c WHERE c.render_id = m.render_id)
     GROUP BY m.render_id
  )
  SELECT jsonb_build_object(
    'missing_renders', (SELECT count(*) FROM missing),
    'missing_pins', (SELECT coalesce(sum(pins), 0) FROM missing),
    'missing_recent_renders', (SELECT count(*) FROM missing
                                WHERE first_minted_at > now() - make_interval(days => greatest(coalesce(p_recent_days, 14), 0))),
    'recent_days', greatest(coalesce(p_recent_days, 14), 0),
    'sample', coalesce((
      SELECT jsonb_agg(jsonb_build_object('render_id', s.render_id, 'pins', s.pins, 'first_minted_at', s.first_minted_at)
                       ORDER BY s.first_minted_at DESC, s.render_id)
        FROM (SELECT * FROM missing ORDER BY first_minted_at DESC, render_id
               LIMIT greatest(coalesce(p_sample, 10), 0)) s), '[]'::jsonb)
  )
$function$;
-- <<< END verbatim pinnacle_minted_renders_missing_from_catalog <<<

INSERT INTO public.pinnacle_catalog VALUES ('IN-CAT');
INSERT INTO public.pinnacle_mint_events VALUES
  ('1', 'IN-CAT', now() - interval '1 day'),      -- catalogued: never counted
  ('2', 'NEW-A',  now() - interval '2 days'),     -- recent, 2 pins
  ('3', 'NEW-A',  now() - interval '1 day'),
  ('4', 'OLD-B',  now() - interval '200 days'),   -- old orphan, 1 pin
  ('5', NULL,     now());                         -- no render: ignored

DO $$
DECLARE r jsonb;
BEGIN
  r := public.pinnacle_minted_renders_missing_from_catalog(10, 14);
  PERFORM _assert_eq(r->>'missing_renders', '2', 'two minted renders lack a catalog row');
  PERFORM _assert_eq(r->>'missing_pins', '3', 'covering three pins');
  PERFORM _assert_eq(r->>'missing_recent_renders', '1', 'one of them is recent: the source fell behind');
  PERFORM _assert_eq(r->'sample'->0->>'render_id', 'NEW-A', 'the sample leads with the most recently first-minted render');
  PERFORM _assert_eq(r->'sample'->0->>'pins', '2', 'with its pin count');
  r := public.pinnacle_minted_renders_missing_from_catalog(1, 14);
  PERFORM _assert_eq(jsonb_array_length(r->'sample')::text, '1', 'p_sample bounds the sample');
  PERFORM _assert_eq(r->>'missing_renders', '2', 'but never the count');
END $$;

ROLLBACK;

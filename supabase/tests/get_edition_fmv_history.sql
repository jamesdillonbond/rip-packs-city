-- DB invariant: public.get_edition_fmv_history — the per-edition FMV price-history
-- series behind the moment/edition FMV charts. Given (collection, route_slug, days)
-- it returns a jsonb array of one point PER DAY (the latest snapshot that day),
-- within a day-window that is clamped to [1,365]. A regression here silently
-- distorts or truncates every FMV chart — wrong day bucketing, a stale intra-day
-- point winning over the fresh one, or the window clamp leaking.
--
-- Pins:
--   * the standard (non-Pinnacle) path resolves an edition by external_id OR by
--     id::text, and returns points within the window;
--   * DISTINCT ON (day) keeps the LATEST computed_at per day (fresh > stale);
--   * the day-window clamp [1,365] (p_days=0 → 1 day, 9999 → 365, NULL → 30);
--   * an unresolved edition yields '[]' (never NULL);
--   * the Pinnacle branch resolves render-keyed history from pinnacle_fmv_history.
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20260711185416_audit_20260711_fmv_snapshots_rename_wap_to_asp.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts from it.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

-- ── minimal fixtures (only the columns the function reads) ────────────────────
CREATE TABLE public.editions (id uuid PRIMARY KEY, collection_id uuid, external_id text);
CREATE TABLE public.fmv_snapshots (
  edition_id uuid, computed_at timestamptz, fmv_usd numeric, asp_usd numeric,
  floor_price_usd numeric, confidence text, sales_count_30d integer);
CREATE TABLE public.pinnacle_catalog (
  render_id text, edition_id text, fmv_sales_count_30d integer, total_minted integer);
CREATE TABLE public.pinnacle_fmv_history (
  render_id text, computed_at timestamptz, fmv_usd numeric,
  fmv_confidence text, fmv_sales_count_30d integer);

-- >>> BEGIN verbatim get_edition_fmv_history (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.get_edition_fmv_history(p_collection_id uuid, p_route_slug text, p_days integer DEFAULT 30)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '8s'
AS $function$
DECLARE
  v_pinnacle_uuid CONSTANT uuid := '7dd9dd11-e8b6-45c4-ac99-71331f959714';
  v_safe_days     int := LEAST(GREATEST(COALESCE(p_days, 30), 1), 365);
  v_cutoff        timestamptz := NOW() - (v_safe_days || ' days')::interval;
  result jsonb;
BEGIN
  IF p_collection_id = v_pinnacle_uuid THEN
    WITH r AS (
      SELECT pc.render_id
      FROM pinnacle_catalog pc
      WHERE pc.render_id = p_route_slug
         OR pc.edition_id = p_route_slug
      ORDER BY (pc.render_id = p_route_slug) DESC,
               pc.fmv_sales_count_30d DESC NULLS LAST,
               pc.total_minted ASC NULLS LAST
      LIMIT 1
    ),
    daily AS (
      SELECT DISTINCT ON (DATE(h.computed_at))
        DATE(h.computed_at)        AS day,
        h.fmv_usd,
        NULL::numeric              AS wap_usd,
        NULL::numeric              AS floor_usd,
        h.fmv_confidence           AS confidence,
        h.fmv_sales_count_30d      AS sales_count_30d,
        h.computed_at
      FROM r
      JOIN pinnacle_fmv_history h ON h.render_id = r.render_id
      WHERE h.computed_at >= v_cutoff
      ORDER BY DATE(h.computed_at), h.computed_at DESC
    )
    SELECT COALESCE(jsonb_agg(to_jsonb(daily.*) ORDER BY daily.day), '[]'::jsonb)
    INTO result
    FROM daily;
  ELSE
    WITH ed AS (
      SELECT id FROM editions
      WHERE collection_id = p_collection_id
        AND (external_id = p_route_slug OR id::text = p_route_slug)
      LIMIT 1
    ),
    daily AS (
      SELECT DISTINCT ON (DATE(f.computed_at))
        DATE(f.computed_at)            AS day,
        f.fmv_usd,
        f.asp_usd                      AS wap_usd,
        f.floor_price_usd              AS floor_usd,
        f.confidence::text             AS confidence,
        f.sales_count_30d,
        f.computed_at
      FROM ed
      JOIN fmv_snapshots f ON f.edition_id = ed.id
      WHERE f.computed_at >= v_cutoff
      ORDER BY DATE(f.computed_at), f.computed_at DESC
    )
    SELECT COALESCE(jsonb_agg(to_jsonb(daily.*) ORDER BY daily.day), '[]'::jsonb)
    INTO result
    FROM daily;
  END IF;

  RETURN result;
END;
$function$;
-- <<< END verbatim get_edition_fmv_history <<<

\set cid '''11111111-1111-1111-1111-111111111111'''
\set eid '''22222222-2222-2222-2222-222222222222'''
\set pin '''7dd9dd11-e8b6-45c4-ac99-71331f959714'''

INSERT INTO public.editions (id, collection_id, external_id) VALUES (:eid::uuid, :cid::uuid, '3:45');

-- Two snapshots TODAY (different computed_at) + one 10 days ago + one 100 days ago.
INSERT INTO public.fmv_snapshots (edition_id, computed_at, fmv_usd, asp_usd, floor_price_usd, confidence, sales_count_30d) VALUES
  (:eid::uuid, now() - interval '2 hours',  50, 48, 40, 'HIGH',   9),  -- today, stale intra-day
  (:eid::uuid, now() - interval '10 minutes', 55, 52, 44, 'HIGH',  9), -- today, freshest -> should win
  (:eid::uuid, now() - interval '10 days',  30, 29, 25, 'MEDIUM', 4),  -- inside 30d
  (:eid::uuid, now() - interval '100 days', 20, 19, 15, 'LOW',    1);  -- outside 30d, inside 365d

-- ── 1. standard path, external_id, default 30-day window ─────────────────────
SELECT _assert_eq(jsonb_array_length(public.get_edition_fmv_history(:cid::uuid, '3:45', 30))::text, '2', 'default 30d -> 2 daily points (today + 10d; 100d excluded)');
-- DISTINCT ON (day): today's point is the FRESH one (55), not the stale 50.
SELECT _assert_eq(
  (SELECT (elem->>'fmv_usd') FROM jsonb_array_elements(public.get_edition_fmv_history(:cid::uuid, '3:45', 30)) elem
   ORDER BY (elem->>'day') DESC LIMIT 1),
  '55', 'latest-per-day: freshest intra-day snapshot wins');

-- ── 2. resolves by id::text as well as external_id ───────────────────────────
SELECT _assert(jsonb_array_length(public.get_edition_fmv_history(:cid::uuid, :eid, 30)) = 2, 'resolves edition by id::text');

-- ── 3. day-window clamp [1,365] ──────────────────────────────────────────────
-- 365 includes the 100-day-old point -> 3 daily points.
SELECT _assert_eq(jsonb_array_length(public.get_edition_fmv_history(:cid::uuid, '3:45', 9999))::text, '3', 'p_days 9999 clamps to 365 -> includes the 100d point');
-- 0 clamps to 1 day -> only today's point.
SELECT _assert_eq(jsonb_array_length(public.get_edition_fmv_history(:cid::uuid, '3:45', 0))::text, '1', 'p_days 0 clamps to 1 -> today only');
-- NULL -> 30 (same as case 1).
SELECT _assert_eq(jsonb_array_length(public.get_edition_fmv_history(:cid::uuid, '3:45', NULL))::text, '2', 'p_days NULL defaults to 30');

-- ── 4. unresolved edition -> '[]' (never NULL) ───────────────────────────────
SELECT _assert_eq(public.get_edition_fmv_history(:cid::uuid, 'no-such-edition', 30)::text, '[]', 'unresolved slug -> empty array, not NULL');

-- ── 5. Pinnacle branch: render-keyed history ─────────────────────────────────
INSERT INTO public.pinnacle_catalog (render_id, edition_id, fmv_sales_count_30d, total_minted) VALUES ('rend-1', 'ed-1', 5, 100);
INSERT INTO public.pinnacle_fmv_history (render_id, computed_at, fmv_usd, fmv_confidence, fmv_sales_count_30d) VALUES
  ('rend-1', now() - interval '1 day', 12, 'MEDIUM', 3),
  ('rend-1', now() - interval '2 days', 11, 'MEDIUM', 2);
SELECT _assert_eq(jsonb_array_length(public.get_edition_fmv_history(:pin::uuid, 'rend-1', 30))::text, '2', 'Pinnacle branch: 2 render-keyed daily points');

SELECT '✓ get_edition_fmv_history: all assertions passed' AS result;

ROLLBACK;

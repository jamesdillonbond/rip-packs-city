-- DB invariant: public.analytics_fmv_tier_pulse — the FMV Health card and the
-- site-wide FMV dashboard. Added 2026-09-28 with its Pinnacle arm: Pinnacle's
-- FMV lives on pinnacle_catalog and never reaches fmv_snapshots_2026, so the
-- card read "No FMV coverage yet." for 1,580 priced pins.
--
-- Claims:
--   1. Pinnacle rows come from pinnacle_catalog, grouped by variant, counting
--      only pins priced in the last 24 h and not ASK_ONLY.
--   2. A Pinnacle row in fmv_snapshots_2026 is not counted a second time.
--   3. The p_collections filter selects 'pinnacle'; other arms are unchanged.
--
-- The function DDL below is VERBATIM from the committed migration
-- (supabase/migrations/20260929022013_audit_20260928_pinnacle_analytics_fmv_health_and_order_book.sql).
-- __tests__/db-invariants-drift-guard.test.ts fails CI on drift.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE public.collections (id uuid PRIMARY KEY, slug text, is_active boolean);
CREATE TABLE public.editions (id uuid PRIMARY KEY, tier text);
CREATE TABLE public.fmv_snapshots_2026 (edition_id uuid, collection_id uuid, fmv_usd numeric, confidence text, computed_at timestamptz);
CREATE TABLE public.pinnacle_catalog (render_id text PRIMARY KEY, variant text, fmv_usd numeric, fmv_confidence text, fmv_computed_at timestamptz);

CREATE OR REPLACE FUNCTION public.analytics_fmv_tier_pulse(p_collections text[] DEFAULT NULL::text[])
 RETURNS TABLE(collection text, tier text, edition_count bigint, total_fmv_usd numeric, avg_fmv_usd numeric, median_fmv_usd numeric, high_conf_count bigint, low_conf_count bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  RETURN QUERY
  WITH latest_fmv AS (
    SELECT DISTINCT ON (s.edition_id)
      s.edition_id,
      s.fmv_usd,
      s.confidence::text AS confidence,
      (CASE c.slug
        WHEN 'nba_top_shot'    THEN 'topshot'
        WHEN 'nfl_all_day'     THEN 'allday'
        WHEN 'laliga_golazos'  THEN 'golazos'
        WHEN 'ufc_strike'      THEN 'ufc'
        ELSE c.slug::text
      END)::text AS coll
    FROM fmv_snapshots_2026 s
    JOIN collections c ON c.id = s.collection_id
    WHERE s.computed_at >= now() - interval '24 hours'
      AND s.confidence != 'ASK_ONLY'
      AND c.is_active = true
      AND c.slug <> 'disney_pinnacle'
    ORDER BY s.edition_id, s.computed_at DESC
  ),
  -- 2026-09-28: Pinnacle's FMV lives on pinnacle_catalog (one row per pin) and
  -- is never written to fmv_snapshots_2026 (measured: 0 rows), so the FMV Health
  -- card read "No FMV coverage yet." for a collection with 1,580 priced pins.
  -- Same filters as the arm above: computed in the last 24 h, not ASK_ONLY, has
  -- a price. Pinnacle has no rarity tier; the pin's variant stands in for it.
  pinnacle_fmv AS (
    SELECT
      pc.fmv_usd,
      pc.fmv_confidence::text AS confidence,
      'pinnacle'::text AS coll,
      pc.variant AS pin_tier
    FROM pinnacle_catalog pc
    WHERE pc.fmv_computed_at >= now() - interval '24 hours'
      AND pc.fmv_usd IS NOT NULL
      AND pc.fmv_confidence::text <> 'ASK_ONLY'
  ),
  unioned AS (
    SELECT f.coll, COALESCE(e.tier::text, 'UNKNOWN') AS t, f.fmv_usd, f.confidence
    FROM latest_fmv f
    LEFT JOIN editions e ON e.id = f.edition_id
    UNION ALL
    SELECT p.coll, COALESCE(p.pin_tier, 'UNKNOWN') AS t, p.fmv_usd, p.confidence
    FROM pinnacle_fmv p
  )
  SELECT
    u.coll AS collection,
    u.t AS tier,
    COUNT(*)::bigint                                                                AS edition_count,
    COALESCE(ROUND(SUM(u.fmv_usd)::numeric, 0), 0)                                  AS total_fmv_usd,
    COALESCE(ROUND(AVG(u.fmv_usd)::numeric, 2), 0)                                  AS avg_fmv_usd,
    COALESCE(ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY u.fmv_usd)::numeric, 2), 0) AS median_fmv_usd,
    COUNT(*) FILTER (WHERE u.confidence = 'HIGH')::bigint                           AS high_conf_count,
    COUNT(*) FILTER (WHERE u.confidence = 'LOW')::bigint                            AS low_conf_count
  FROM unioned u
  WHERE (p_collections IS NULL OR u.coll = ANY(p_collections))
  GROUP BY u.coll, u.t
  ORDER BY total_fmv_usd DESC;
END;
$function$;

INSERT INTO public.collections VALUES
  ('00000000-0000-0000-0000-00000000000a', 'nba_top_shot', true),
  ('7dd9dd11-e8b6-45c4-ac99-71331f959714', 'disney_pinnacle', true);
INSERT INTO public.editions VALUES ('00000000-0000-0000-0000-0000000000e1', 'RARE'), ('00000000-0000-0000-0000-0000000000e2', 'RARE');
INSERT INTO public.fmv_snapshots_2026 VALUES
  ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-00000000000a', 10, 'HIGH', now()),
  -- a stray Pinnacle snapshot must not double-count
  ('00000000-0000-0000-0000-0000000000e2', '7dd9dd11-e8b6-45c4-ac99-71331f959714', 99, 'HIGH', now());
INSERT INTO public.pinnacle_catalog VALUES
  ('r1', 'Standard',       20, 'HIGH',     now()),
  ('r2', 'Standard',       30, 'LOW',      now()),
  ('r3', 'Radiant Chrome', 50, 'MEDIUM',   now()),
  ('r4', 'Standard',       70, 'ASK_ONLY', now()),                     -- excluded
  ('r5', 'Standard',     NULL, 'NO_DATA',  now()),                     -- excluded
  ('r6', 'Standard',       40, 'HIGH',     now() - interval '2 days'); -- excluded

SELECT _assert_eq((SELECT sum(edition_count)::text FROM public.analytics_fmv_tier_pulse(ARRAY['pinnacle'])), '3', 'three priced, recent, non-ask pins');
SELECT _assert_eq((SELECT total_fmv_usd::text FROM public.analytics_fmv_tier_pulse(ARRAY['pinnacle']) WHERE tier = 'Standard'), '50', 'Standard = 20 + 30');
SELECT _assert_eq((SELECT high_conf_count::text || '/' || low_conf_count::text FROM public.analytics_fmv_tier_pulse(ARRAY['pinnacle']) WHERE tier = 'Standard'), '1/1', 'confidence split per variant');
SELECT _assert_eq((SELECT edition_count::text FROM public.analytics_fmv_tier_pulse(ARRAY['pinnacle']) WHERE tier = 'Radiant Chrome'), '1', 'variant stands in for tier');
SELECT _assert_eq((SELECT count(*)::text FROM public.analytics_fmv_tier_pulse(ARRAY['topshot'])), '1', 'the filter excludes Pinnacle');
SELECT _assert_eq((SELECT string_agg(collection || ':' || edition_count, ',' ORDER BY collection, edition_count) FROM public.analytics_fmv_tier_pulse(NULL) WHERE collection IN ('pinnacle', 'disney_pinnacle', 'topshot')), 'pinnacle:1,pinnacle:2,topshot:1', 'no snapshot-arm Pinnacle row; Top Shot unchanged');

SELECT '✓ analytics_fmv_tier_pulse: all assertions passed' AS result;

ROLLBACK;

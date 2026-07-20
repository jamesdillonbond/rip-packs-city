-- DB invariant: public.refresh_topshot_fmv_display_guard — the read-side FMV
-- display-honesty guard consumed by lib/fmv-display-guard.ts on /api/market +
-- /api/sniper-feed. It decides, per Top Shot edition, whether the displayed FMV
-- is untrustworthy (is_thin / fmv_exceeds_max / fmv_disconnected) and, if so, the
-- honest clamp_target. A regression here either shows a fake deal (a disconnected
-- FMV that should have been clamped) or hides a real one (a spurious clamp).
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20260702141000_audit_20260702_fmv_display_guard_p90_disconnected.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

-- Minimal fixtures — only the columns the function reads/writes. Real tables are
-- far wider (and sales/fmv_snapshots are partitioned in prod), but a plain table
-- satisfies the SELECT ... FROM public.<t> shape and keeps this self-contained.
CREATE TABLE public.editions (
  id uuid PRIMARY KEY,
  collection_id uuid NOT NULL,
  external_id text NOT NULL,
  circulation_count integer
);
CREATE TABLE public.sales (
  edition_id uuid NOT NULL,
  collection_id uuid NOT NULL,
  price_usd numeric,
  sold_at timestamptz
);
CREATE TABLE public.fmv_snapshots (
  edition_id uuid NOT NULL,
  collection_id uuid NOT NULL,
  fmv_usd numeric,
  confidence text,
  computed_at timestamptz
);
CREATE TABLE public.topshot_fmv_display_guard (
  external_id text,
  edition_id uuid,
  fmv_usd numeric,
  max_sale_90d numeric,
  median_90d numeric,
  n_90d integer,
  is_thin boolean,
  fmv_exceeds_max boolean,
  computed_at timestamptz,
  p90_90d numeric,
  fmv_disconnected boolean NOT NULL DEFAULT false,
  clamp_target numeric
);

-- >>> BEGIN verbatim refresh_topshot_fmv_display_guard (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.refresh_topshot_fmv_display_guard()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '300s'
AS $function$
DECLARE
  v_count integer;
BEGIN
  TRUNCATE public.topshot_fmv_display_guard;

  INSERT INTO public.topshot_fmv_display_guard
    (external_id, edition_id, fmv_usd, max_sale_90d, median_90d, n_90d,
     is_thin, fmv_exceeds_max, computed_at, p90_90d, fmv_disconnected, clamp_target)
  WITH s90 AS (
    SELECT s.edition_id,
           count(*)::integer AS n_90d,
           max(s.price_usd)::numeric AS max_sale_90d,
           (percentile_cont(0.5) WITHIN GROUP (ORDER BY s.price_usd))::numeric AS median_90d,
           count(*) FILTER (WHERE s.price_usd > 0.10)::integer AS n_real,
           (percentile_cont(0.9) WITHIN GROUP (ORDER BY s.price_usd)
              FILTER (WHERE s.price_usd > 0.10))::numeric AS p90_real,
           (percentile_cont(0.5) WITHIN GROUP (ORDER BY s.price_usd)
              FILTER (WHERE s.price_usd > 0.10))::numeric AS med_real
    FROM public.sales s
    WHERE s.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
      AND s.sold_at >= now() - interval '90 days'
      AND s.price_usd > 0
    GROUP BY s.edition_id
  ),
  lf AS (
    SELECT DISTINCT ON (fs.edition_id) fs.edition_id, fs.fmv_usd::numeric AS fmv_usd, fs.confidence
    FROM public.fmv_snapshots fs
    WHERE fs.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
      AND fs.computed_at > now() - interval '10 days'
    ORDER BY fs.edition_id, fs.computed_at DESC
  ),
  scored AS (
    SELECT e.external_id,
           e.id AS edition_id,
           lf.fmv_usd,
           s.max_sale_90d,
           s.median_90d,
           s.n_90d,
           s.p90_real,
           s.med_real,
           (s.n_90d < 15 AND s.median_90d > 0 AND lf.fmv_usd > 1.5 * s.median_90d) AS is_thin,
           (lf.fmv_usd > s.max_sale_90d) AS fmv_exceeds_max,
           (lf.confidence IN ('LOW','ASK_ONLY') AND s.n_real >= 5 AND s.p90_real > 0
             AND ( (COALESCE(e.circulation_count,0) >= 1000 AND lf.fmv_usd > s.p90_real * 3)
                   OR (lf.fmv_usd > s.p90_real * 8) )) AS fmv_disconnected
    FROM public.editions e
    JOIN s90 s ON s.edition_id = e.id
    JOIN lf   ON lf.edition_id = e.id
    WHERE e.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
      AND e.external_id ~ '^[0-9]+:[0-9]+$'
      AND lf.fmv_usd > 0
  )
  SELECT external_id, edition_id, fmv_usd, max_sale_90d, median_90d, n_90d,
         is_thin, fmv_exceeds_max, now(), p90_real, fmv_disconnected,
         CASE WHEN fmv_disconnected
              THEN ROUND(GREATEST(p90_real * 1.5, med_real)::numeric, 2)
              ELSE NULL END AS clamp_target
  FROM scored
  WHERE fmv_exceeds_max OR is_thin OR fmv_disconnected;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$function$;
-- <<< END verbatim refresh_topshot_fmv_display_guard <<<

-- Fixture editions (Top Shot collection). external_id must match ^int:int$ to be
-- scored. Circulation matters for the disconnected rule's >=1000 branch.
INSERT INTO public.editions (id, collection_id, external_id, circulation_count) VALUES
  ('11111111-1111-1111-1111-111111111111','95f28a17-224a-4025-96ad-adf8a4c63bfd','1:1', 5000),   -- disconnected (high circ, 3x rule)
  ('22222222-2222-2222-2222-222222222222','95f28a17-224a-4025-96ad-adf8a4c63bfd','2:2', 50),      -- exceeds-max only
  ('33333333-3333-3333-3333-333333333333','95f28a17-224a-4025-96ad-adf8a4c63bfd','3:3', 60),      -- thin
  ('44444444-4444-4444-4444-444444444444','95f28a17-224a-4025-96ad-adf8a4c63bfd','4:4', 100),     -- clean (no flag → excluded)
  ('55555555-5555-5555-5555-555555555555','95f28a17-224a-4025-96ad-adf8a4c63bfd','abc', 100);     -- non-numeric ext → excluded

-- edition 1: 6 real sales p90≈10, HIGH-circ FMV 40 (> 3*p90) but LOW confidence → disconnected
INSERT INTO public.sales (edition_id, collection_id, price_usd, sold_at)
SELECT '11111111-1111-1111-1111-111111111111','95f28a17-224a-4025-96ad-adf8a4c63bfd', v, now() - interval '5 days'
FROM (VALUES (5),(6),(7),(8),(9),(10)) t(v);
INSERT INTO public.fmv_snapshots (edition_id, collection_id, fmv_usd, confidence, computed_at)
VALUES ('11111111-1111-1111-1111-111111111111','95f28a17-224a-4025-96ad-adf8a4c63bfd', 40, 'LOW', now() - interval '1 day');

-- edition 2: FMV above the max sale but plenty of sales & HIGH confidence → exceeds-max only, not disconnected/thin
INSERT INTO public.sales (edition_id, collection_id, price_usd, sold_at)
SELECT '22222222-2222-2222-2222-222222222222','95f28a17-224a-4025-96ad-adf8a4c63bfd', v, now() - interval '5 days'
FROM (VALUES (10),(11),(12),(13),(14),(15),(16),(17),(18),(19),(20),(21),(22),(23),(24),(25)) t(v); -- n=16 (>=15, not thin)
INSERT INTO public.fmv_snapshots (edition_id, collection_id, fmv_usd, confidence, computed_at)
VALUES ('22222222-2222-2222-2222-222222222222','95f28a17-224a-4025-96ad-adf8a4c63bfd', 30, 'HIGH', now() - interval '1 day');

-- edition 3: few sales (thin), FMV > 1.5*median, but NOT above max → thin only
INSERT INTO public.sales (edition_id, collection_id, price_usd, sold_at)
SELECT '33333333-3333-3333-3333-333333333333','95f28a17-224a-4025-96ad-adf8a4c63bfd', v, now() - interval '5 days'
FROM (VALUES (10),(10),(100)) t(v); -- n=3 (<15), median 10, max 100
INSERT INTO public.fmv_snapshots (edition_id, collection_id, fmv_usd, confidence, computed_at)
VALUES ('33333333-3333-3333-3333-333333333333','95f28a17-224a-4025-96ad-adf8a4c63bfd', 25, 'MEDIUM', now() - interval '1 day'); -- 25 > 1.5*10, 25 < 100

-- edition 4: healthy — many sales, FMV below max & near median → no flag
INSERT INTO public.sales (edition_id, collection_id, price_usd, sold_at)
SELECT '44444444-4444-4444-4444-444444444444','95f28a17-224a-4025-96ad-adf8a4c63bfd', v, now() - interval '5 days'
FROM (VALUES (10),(11),(12),(13),(14),(15),(16),(17),(18),(19),(20),(21),(22),(23),(24),(25)) t(v); -- n=16
INSERT INTO public.fmv_snapshots (edition_id, collection_id, fmv_usd, confidence, computed_at)
VALUES ('44444444-4444-4444-4444-444444444444','95f28a17-224a-4025-96ad-adf8a4c63bfd', 18, 'HIGH', now() - interval '1 day');

-- edition 5: non-numeric external_id — excluded by the ^int:int$ filter regardless.
INSERT INTO public.sales (edition_id, collection_id, price_usd, sold_at)
VALUES ('55555555-5555-5555-5555-555555555555','95f28a17-224a-4025-96ad-adf8a4c63bfd', 10, now() - interval '5 days');
INSERT INTO public.fmv_snapshots (edition_id, collection_id, fmv_usd, confidence, computed_at)
VALUES ('55555555-5555-5555-5555-555555555555','95f28a17-224a-4025-96ad-adf8a4c63bfd', 999, 'LOW', now() - interval '1 day');

-- Run the guard.
SELECT public.refresh_topshot_fmv_display_guard();

-- Only the three flagged editions are present; the clean one + the non-numeric one are excluded.
SELECT _assert_eq((SELECT count(*)::text FROM public.topshot_fmv_display_guard), '3', 'exactly the 3 flagged editions inserted');
SELECT _assert(NOT EXISTS(SELECT 1 FROM public.topshot_fmv_display_guard WHERE edition_id='44444444-4444-4444-4444-444444444444'), 'clean edition excluded');
SELECT _assert(NOT EXISTS(SELECT 1 FROM public.topshot_fmv_display_guard WHERE edition_id='55555555-5555-5555-5555-555555555555'), 'non-numeric external_id excluded');

-- edition 1: disconnected true, and clamp_target = round(greatest(p90*1.5, med),2).
SELECT _assert((SELECT fmv_disconnected FROM public.topshot_fmv_display_guard WHERE edition_id='11111111-1111-1111-1111-111111111111'), 'edition 1 flagged disconnected');
SELECT _assert((SELECT clamp_target FROM public.topshot_fmv_display_guard WHERE edition_id='11111111-1111-1111-1111-111111111111') IS NOT NULL, 'disconnected row carries a clamp_target');

-- edition 2: exceeds-max but NOT disconnected/thin → clamp_target NULL.
SELECT _assert((SELECT fmv_exceeds_max FROM public.topshot_fmv_display_guard WHERE edition_id='22222222-2222-2222-2222-222222222222'), 'edition 2 exceeds max');
SELECT _assert(NOT (SELECT fmv_disconnected FROM public.topshot_fmv_display_guard WHERE edition_id='22222222-2222-2222-2222-222222222222'), 'edition 2 not disconnected (HIGH confidence)');
SELECT _assert((SELECT clamp_target FROM public.topshot_fmv_display_guard WHERE edition_id='22222222-2222-2222-2222-222222222222') IS NULL, 'non-disconnected row has NULL clamp_target');

-- edition 3: thin true, exceeds-max false (25 < 100).
SELECT _assert((SELECT is_thin FROM public.topshot_fmv_display_guard WHERE edition_id='33333333-3333-3333-3333-333333333333'), 'edition 3 flagged thin');
SELECT _assert(NOT (SELECT fmv_exceeds_max FROM public.topshot_fmv_display_guard WHERE edition_id='33333333-3333-3333-3333-333333333333'), 'edition 3 does not exceed max');

SELECT '✓ refresh_topshot_fmv_display_guard invariants pass' AS result;
ROLLBACK;

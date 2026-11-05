-- DB invariant: public.refresh_fmv_accuracy_weekly — the weekly FMV accuracy instrument (2026-11-04): each market sale
-- in a PT week (sales_market, serial > 25, price > 0) vs the fmv_snapshots row in force >= 1 day before it, grouped by
-- confidence x last-sale age x 90-day depth x price band.
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (20261105040000_audit_20261104_fmv_accuracy_weekly);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE sales_market (
  collection_id uuid, edition_id uuid, price_usd numeric, sold_at timestamptz, serial_number integer);
CREATE TABLE fmv_snapshots (
  edition_id uuid, fmv_usd numeric, confidence text, computed_at timestamptz);
CREATE TABLE IF NOT EXISTS public.fmv_accuracy_weekly (
  collection_id   uuid NOT NULL,
  week_start      date NOT NULL,          -- PT Monday
  confidence      text NOT NULL,
  last_sale_age   text NOT NULL,          -- '<=7d' | '8-30d' | '31-90d' | '91-180d' | 'none'
  depth           text NOT NULL,          -- '3+/90d' | '<3/90d'
  price_band      text NOT NULL,          -- '<$10' | '$10-50' | '$50-200' | '$200+'
  n               integer NOT NULL,
  within_25_pct   numeric NOT NULL,
  median_ratio    numeric,
  wape            numeric,
  computed_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (collection_id, week_start, confidence, last_sale_age, depth, price_band)
);

-- >>> BEGIN verbatim refresh_fmv_accuracy_weekly (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.refresh_fmv_accuracy_weekly(p_collection uuid, p_week_start date)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_from timestamptz := (p_week_start::timestamp AT TIME ZONE 'America/Los_Angeles');
  v_to   timestamptz := ((p_week_start + 7)::timestamp AT TIME ZONE 'America/Los_Angeles');
  v_n integer;
BEGIN
  IF extract(isodow FROM p_week_start) <> 1 THEN
    RAISE EXCEPTION 'week_start must be a Monday (PT week), got %', p_week_start;
  END IF;

  DELETE FROM public.fmv_accuracy_weekly WHERE collection_id = p_collection AND week_start = p_week_start;

  WITH tgt AS (
    SELECT s.edition_id, s.price_usd, s.sold_at
      FROM public.sales_market s
     WHERE s.collection_id = p_collection
       AND s.sold_at >= v_from AND s.sold_at < v_to
       AND COALESCE(s.serial_number, 999999) > 25
       AND s.price_usd > 0
  ), snap AS (
    SELECT t.*, f.fmv_usd AS pub, f.confidence::text AS conf
      FROM tgt t
      JOIN LATERAL (
        SELECT x.fmv_usd, x.confidence FROM public.fmv_snapshots x
         WHERE x.edition_id = t.edition_id AND x.computed_at <= t.sold_at - interval '1 day'
         ORDER BY x.computed_at DESC LIMIT 1) f ON true
     WHERE f.fmv_usd IS NOT NULL AND f.fmv_usd > 0
  ), feat AS (
    SELECT sn.*,
           l.t AS last_t,
           (SELECT count(*) FROM public.sales_market z
             WHERE z.edition_id = sn.edition_id AND COALESCE(z.serial_number, 999999) > 25 AND z.price_usd > 0
               AND z.sold_at < sn.sold_at - interval '1 day' AND z.sold_at > sn.sold_at - interval '90 days') AS n90
      FROM snap sn
      LEFT JOIN LATERAL (
        SELECT y.sold_at AS t FROM public.sales_market y
         WHERE y.edition_id = sn.edition_id AND COALESCE(y.serial_number, 999999) > 25 AND y.price_usd > 0
           AND y.sold_at < sn.sold_at - interval '1 day' AND y.sold_at > sn.sold_at - interval '180 days'
         ORDER BY y.sold_at DESC LIMIT 1) l ON true
  ), seg AS (
    SELECT conf,
           CASE WHEN last_t IS NULL THEN 'none'
                WHEN sold_at - last_t <= interval '7 days' THEN '<=7d'
                WHEN sold_at - last_t <= interval '30 days' THEN '8-30d'
                WHEN sold_at - last_t <= interval '90 days' THEN '31-90d'
                ELSE '91-180d' END AS last_sale_age,
           CASE WHEN n90 >= 3 THEN '3+/90d' ELSE '<3/90d' END AS depth,
           CASE WHEN price_usd < 10 THEN '<$10' WHEN price_usd < 50 THEN '$10-50'
                WHEN price_usd < 200 THEN '$50-200' ELSE '$200+' END AS price_band,
           pub, price_usd
      FROM feat
  )
  INSERT INTO public.fmv_accuracy_weekly
    (collection_id, week_start, confidence, last_sale_age, depth, price_band, n, within_25_pct, median_ratio, wape)
  SELECT p_collection, p_week_start, conf, last_sale_age, depth, price_band,
         count(*),
         round(100.0 * avg((abs(pub / price_usd - 1) <= 0.25)::int), 1),
         round((percentile_cont(0.5) WITHIN GROUP (ORDER BY pub / price_usd))::numeric, 3),
         round((sum(abs(pub - price_usd)) / NULLIF(sum(price_usd), 0))::numeric, 3)
    FROM seg
   GROUP BY conf, last_sale_age, depth, price_band;

  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$function$;
-- <<< END verbatim refresh_fmv_accuracy_weekly <<<

-- PT week of Monday 2026-10-26 = [2026-10-26 07:00Z, 2026-11-02 08:00Z) (PDT -> PST on 11-01).
--   a1 HIGH snapshot 10.00 (10-20); sales 10-28 at 10.00 and 12.00, serial 500/600; prior sales 10-25, 10-10, 09-30
--      -> one HIGH row, '<=7d', '3+/90d', '$10-50', n 2, within 100 %, median ratio (1.0, 0.8333) -> 0.917
--   a2 snapshot 10-27 05:00Z is < 1 day before a 10-27 20:00Z sale -> the OLDER 10-01 snapshot (LOW 2.00) is used,
--      sale 4.00, no prior sale -> LOW 'none' '<3/90d' '<$10', within 0, ratio 0.5
--   a3 sale serial 7 -> excluded;  a4 sale 2026-11-02 09:00Z (next PT week) -> excluded
--   a5 sale 10-26 07:30Z (00:30 PDT Monday -> IN the week), MEDIUM snapshot 300, sale 200, prior sale 09-10
--      -> MEDIUM '31-90d' '<3/90d' '$200+', within 0, ratio 1.5, wape 0.5
--   other collection -> excluded
INSERT INTO fmv_snapshots VALUES
  ('a1000000-0000-0000-0000-000000000001', 10.00, 'HIGH',     '2026-10-20 00:00Z'),
  ('a1000000-0000-0000-0000-000000000002',  2.00, 'LOW',      '2026-10-01 00:00Z'),
  ('a1000000-0000-0000-0000-000000000002', 99.00, 'HIGH',     '2026-10-27 05:00Z'),
  ('a1000000-0000-0000-0000-000000000003',  5.00, 'HIGH',     '2026-10-01 00:00Z'),
  ('a1000000-0000-0000-0000-000000000004',  5.00, 'HIGH',     '2026-10-01 00:00Z'),
  ('a1000000-0000-0000-0000-000000000005',300.00, 'MEDIUM',   '2026-10-01 00:00Z'),
  ('a1000000-0000-0000-0000-000000000006',  5.00, 'HIGH',     '2026-10-01 00:00Z');
INSERT INTO sales_market VALUES
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'a1000000-0000-0000-0000-000000000001', 10.00, '2026-10-28 19:00Z', 500),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'a1000000-0000-0000-0000-000000000001', 12.00, '2026-10-28 20:00Z', 600),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'a1000000-0000-0000-0000-000000000001',  9.00, '2026-10-25 12:00Z', 700),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'a1000000-0000-0000-0000-000000000001',  9.50, '2026-10-10 12:00Z', 800),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'a1000000-0000-0000-0000-000000000001',  8.50, '2026-09-30 12:00Z', 900),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'a1000000-0000-0000-0000-000000000002',  4.00, '2026-10-27 20:00Z', 100),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'a1000000-0000-0000-0000-000000000003',  5.00, '2026-10-28 20:00Z', 7),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'a1000000-0000-0000-0000-000000000004',  5.00, '2026-11-02 09:00Z', 100),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'a1000000-0000-0000-0000-000000000005',200.00, '2026-10-26 07:30Z', 100),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'a1000000-0000-0000-0000-000000000005',250.00, '2026-09-10 12:00Z', 100),
  ('00000000-0000-0000-0000-0000000000ff', 'a1000000-0000-0000-0000-000000000006', 5.00, '2026-10-28 20:00Z', 100);

SELECT _assert_eq(refresh_fmv_accuracy_weekly('95f28a17-224a-4025-96ad-adf8a4c63bfd', DATE '2026-10-26')::text, '3', 'three segments written');
SELECT _assert_eq((SELECT string_agg(confidence||'|'||last_sale_age||'|'||depth||'|'||price_band||'|'||n||'|'||within_25_pct||'|'||median_ratio||'|'||wape, ' ; ' ORDER BY confidence)
                     FROM fmv_accuracy_weekly),
  'HIGH|<=7d|3+/90d|$10-50|2|100.0|0.917|0.091 ; LOW|none|<3/90d|<$10|1|0.0|0.500|0.500 ; MEDIUM|31-90d|<3/90d|$200+|1|0.0|1.500|0.500',
  'segments, counts, accuracy, ratio and wape');
-- idempotent: a re-run replaces the week, never doubles it
SELECT refresh_fmv_accuracy_weekly('95f28a17-224a-4025-96ad-adf8a4c63bfd', DATE '2026-10-26');
SELECT _assert_eq((SELECT sum(n)::text FROM fmv_accuracy_weekly), '4', 're-run replaces, does not add');
-- a non-Monday is refused
DO $t$ BEGIN
  PERFORM refresh_fmv_accuracy_weekly('95f28a17-224a-4025-96ad-adf8a4c63bfd', DATE '2026-10-27');
  RAISE EXCEPTION 'expected a refusal';
EXCEPTION WHEN raise_exception THEN
  IF SQLERRM NOT LIKE 'week_start must be a Monday%' THEN RAISE; END IF;
END $t$;
-- an empty week writes nothing and still succeeds
SELECT _assert_eq(refresh_fmv_accuracy_weekly('95f28a17-224a-4025-96ad-adf8a4c63bfd', DATE '2026-11-09')::text, '0', 'an empty week writes 0 rows');

ROLLBACK;

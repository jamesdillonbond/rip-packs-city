-- audit_20261104_fmv_accuracy_weekly — 2026-11-04 ~8:05 PM PT (Claude Code cloud; Trevor: "We need to get confidence on
-- pricing. That's the anchor of everything we do." → "Keep going and do it all").
--
-- The instrument for "confidence = measured accuracy". Until tonight a confidence label was a 30-day SALES COUNT
-- (HIGH >= 7, MEDIUM >= 5) and nothing recorded how accurate each kind of price actually was. Measured 11-04 on clean
-- Top Shot sales since 10-23: HIGH 73-77 % within +/-25 %, MEDIUM 69 % — but MEDIUM whose last sale is 31-90 days old
-- only 53 %, while an ask-only price capped at a recent sale with 3+ sales in 90 d reached 69 %. The label and the
-- accuracy disagree both ways, and nothing measured it week to week.
--
-- fmv_accuracy_weekly holds, per collection x PT week x segment, how the PUBLISHED price did against the sales that
-- followed it: each market sale (sales_market, serial > 25, price > 0) vs the fmv_snapshots row in force >= 1 day
-- before it (information available a day ahead — the R125 / fmv_sales_backtest shape). Segments:
--   confidence (as labelled)  x  last-sale age before the sale (<=7d / 8-30d / 31-90d / 91-180d / none)
--   x  depth (>= 3 market sales in the 90 d before / fewer)  x  price band of the sale (<$10 / $10-50 / $50-200 / $200+)
-- Columns: n, within ±25 % share, median price/sale ratio, WAPE. refresh_fmv_accuracy_weekly(collection, week_start)
-- rebuilds one week (delete-then-insert, idempotent); a weekly pg_cron job fills the PT week that just closed.
--
-- What it is FOR: (1) a label is honest when its segment's measured within ±25 % matches the label's promise —
-- relabelling waits for a week of data under the 11-04 price changes (20261105024000 last-sale cap,
-- 20261105033000 offer floor), because calibrating labels on the old prices would calibrate the wrong prices;
-- (2) the weekly trend is the scorecard for every pricing change from here on.
--
-- Cost: one pass over a week of one collection's sales with two indexed LIMIT-1 laterals per sale (~110 s for 12 days
-- of Top Shot ad hoc on 11-04, warm); weekly, Monday 03:37 PT (11:37 UTC — not a rush minute, not a 6-hour multiple).
--
-- anon-exec: intentional — refresh_fmv_accuracy_weekly is SECURITY DEFINER for the pg_cron caller; EXECUTE revoked from PUBLIC/anon/authenticated below (refresh_fmv_accuracy_weekly)
--
-- REVERT: SELECT cron.unschedule('rpc-fmv-accuracy-weekly'); DROP FUNCTION public.refresh_fmv_accuracy_weekly(uuid, date);
--         DROP TABLE public.fmv_accuracy_weekly;

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
ALTER TABLE public.fmv_accuracy_weekly ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.fmv_accuracy_weekly FROM PUBLIC, anon, authenticated;

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

REVOKE ALL ON FUNCTION public.refresh_fmv_accuracy_weekly(uuid, date) FROM PUBLIC, anon, authenticated;

COMMENT ON TABLE public.fmv_accuracy_weekly IS
  'Measured accuracy of the PUBLISHED FMV per collection x PT week x segment (confidence, last-sale age, 90-day depth, price band): each market sale vs the snapshot in force >= 1 day before it. The instrument for "confidence = measured accuracy" (2026-11-04). Filled weekly by rpc-fmv-accuracy-weekly; refresh_fmv_accuracy_weekly(collection, monday) rebuilds one week.';

-- Weekly: the PT week that just closed, Top Shot first (the collection whose labels were measured 11-04).
SELECT cron.schedule(
  'rpc-fmv-accuracy-weekly',
  '37 11 * * 1',
  $cron$SELECT public.refresh_fmv_accuracy_weekly('95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid,
          (date_trunc('week', (now() AT TIME ZONE 'America/Los_Angeles'))::date - 7))$cron$
);

-- No backfill here (a week of Top Shot is ~60 s; keep the DDL apply short). After apply, run once via execute_sql:
--   SELECT public.refresh_fmv_accuracy_weekly('95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid, DATE '2026-10-26');
-- (PT Monday 10-26: the first full week after the 10-21/22 frozen-ask fix.) The 11-02 week fills on Monday 11-09.

-- audit_20261104_topshot_ask_only_recent_sales_histcap — 2026-11-04 ~5:39 PM PT (Claude Code cloud; autonomous pass).
--
-- Extends the Top Shot _histcap bound to editions WITH a 180-day sale. Until now a Top Shot ASK_ONLY
-- price had no bound at all once the edition had sold in the last 180 days (the _salescap arm, a cap
-- AT the last-3 median, stays OFF: #208 measured Top Shot's ASK_ONLY read as well calibrated, ratio
-- 0.97, and the 1x cap as not a win). Found from the 7-day market-cap movers: Jrue Holiday's 2021 NBA
-- Finals /73 (41:1463) went $899 -> $2,700 ASK_ONLY on 11-03 after sales of $419-$725 (last 06-07),
-- alone moving "Jrue Holiday" +83 % and "2021 NBA Finals" +54 % in a week.
--
-- New arm: Top Shot, ASK_ONLY, a 180-day last-3 median exists and the price is above 3x it -> capped at
-- 3x, marked _histcap (the suffix lib/fmv-capped.ts, lib/fmv-basis.ts and get_edition_detail's
-- basis_capped already read as "held to the edition's sales"). It only ever LOWERS a price.
-- Backtest (sales_market, serial > 25, Top Shot sales whose snapshot in force >= 1 d before was
-- ASK_ONLY and above 3x the median of the edition's last 3 sales in the 180 d before the sale):
--   recent 45 d:   n_ask 1,210, moved 37:  within +/-25 0 -> 0, WAPE 10.19 -> 2.12, median ratio 6.30 -> 3.00
--   older 45-90 d: n_ask 1,857, moved 100: within +/-25 5 -> 9 %, WAPE 3.59 -> 1.81, median ratio 3.14 -> 3.00
-- 137 moved (>= the ~60 bar), better on every metric in both halves; 7 % of moved sales sold above the cap.
-- Today it binds 93 latest Top Shot ASK_ONLY rows, $24,896 -> $17,520 summed (largest cut $2,403).
-- Cost: none new -- v_med is already read for every Top Shot ASK_ONLY insert.
-- The re-price also writes edition_fmv_current: its incremental refresh windows on computed_at, which an
-- in-place UPDATE does not move. Applied 2026-11-04 ~5:39 PM PT: 93 rows, $24,896 -> $17,520; Jrue 41:1463 $2,700 -> $2,085.
--
-- anon-exec: intentional — trigger function (RETURNS trigger), never callable through PostgREST; EXECUTE already revoked from PUBLIC/anon/authenticated in 20261023045044 and CREATE OR REPLACE keeps the ACL (fmv_snapshots_cap_allday_ask_only_to_recent_sales)
--
-- REVERT: re-apply the function body in 20261029163623, then
--   UPDATE public.fmv_snapshots f SET fmv_usd = b.old_fmv_usd, algo_version = b.old_algo_version
--     FROM public.audit_20261104_topshot_ask_only_recent_histcap_backup b WHERE f.id = b.snapshot_id;
--   UPDATE public.edition_fmv_current c SET fmv_usd = b.old_fmv_usd
--     FROM public.audit_20261104_topshot_ask_only_recent_histcap_backup b
--    WHERE c.edition_id = b.edition_id AND c.fmv_usd = b.new_fmv_usd;

DO $guard$
BEGIN
  IF (SELECT md5(trim(regexp_replace(prosrc, '\s+', ' ', 'g'))) FROM pg_proc
       WHERE oid = 'public.fmv_snapshots_cap_allday_ask_only_to_recent_sales()'::regprocedure)
     <> 'a94d6409a4d1854c5de3fb77305a6c6c' THEN
    RAISE EXCEPTION 'live body is not the 20261029163623 body this migration was written against; re-read it';
  END IF;
END
$guard$;

CREATE OR REPLACE FUNCTION public.fmv_snapshots_cap_allday_ask_only_to_recent_sales()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  -- NFL All Day and LaLiga Golazos (collections.id). Scoped by measurement: the same cap is not a win on Top Shot.
  c_allday  constant uuid := 'dee28451-5d62-409e-a1ad-a83f763ac070';
  c_golazos constant uuid := '06248cc4-b85f-47cd-af67-1855d14acd75';
  -- NBA Top Shot: in the _histcap arm only (2026-10-29; with a recent sale too since 2026-11-04); its _salescap arm stays off by measurement.
  c_topshot constant uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_med numeric;
  v_hist numeric;
BEGIN
  IF NEW.collection_id IN (c_allday, c_golazos, c_topshot)
     AND NEW.confidence = 'ASK_ONLY'
     AND NEW.fmv_usd IS NOT NULL
     AND NEW.edition_id IS NOT NULL
  THEN
    SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY q.price_usd)
      INTO v_med
      FROM (
        SELECT y.price_usd
          FROM public.sales_market y
         WHERE y.edition_id = NEW.edition_id
           AND y.sold_at > now() - interval '180 days'
           AND y.price_usd > 0
           AND COALESCE(y.serial_number, 999999) > 25
         ORDER BY y.sold_at DESC
         LIMIT 3
      ) q;
    IF NEW.collection_id IN (c_allday, c_golazos) AND v_med IS NOT NULL AND v_med > 0 AND NEW.fmv_usd > v_med THEN
      NEW.fmv_usd := round(v_med, 2);
      NEW.algo_version := COALESCE(NEW.algo_version, '') || '_salescap';
    ELSIF NEW.collection_id = c_topshot AND v_med IS NOT NULL AND v_med > 0 AND NEW.fmv_usd > 3 * v_med THEN
      -- 2026-11-04: Top Shot WITH a 180-day sale -- not capped AT the median (#208: not a win), but bounded
      -- at 3x it, the same multiple the no-recent-sale arm uses. Backtested 90 d: n 137 moved, both halves better.
      NEW.fmv_usd := round(3 * v_med, 2);
      NEW.algo_version := COALESCE(NEW.algo_version, '') || '_histcap';
    ELSIF v_med IS NULL AND NEW.collection_id IN (c_allday, c_topshot) THEN
      -- 2026-10-29: no sale in 180 days, but an older history bounds the ask at 3x its last-3 median.
      SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY q.price_usd)
        INTO v_hist
        FROM (
          SELECT y.price_usd
            FROM public.sales_market y
           WHERE y.edition_id = NEW.edition_id
             AND y.price_usd > 0
             AND COALESCE(y.serial_number, 999999) > 25
           ORDER BY y.sold_at DESC
           LIMIT 3
        ) q;
      IF v_hist IS NOT NULL AND v_hist > 0 AND NEW.fmv_usd > 3 * v_hist THEN
        NEW.fmv_usd := round(3 * v_hist, 2);
        NEW.algo_version := COALESCE(NEW.algo_version, '') || '_histcap';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.fmv_snapshots_cap_allday_ask_only_to_recent_sales() IS
  'BEFORE INSERT guard on fmv_snapshots: an NFL All Day (2026-10-22) or LaLiga Golazos (2026-10-23) ASK_ONLY fmv_usd is capped at the median of the edition''s last 3 market sales within 180 days (serial > 25), marked algo_version …_salescap. A Top Shot ASK_ONLY price above 3x that median is capped at 3x, marked …_histcap (2026-11-04). With no sale in 180 days, an All Day or Top Shot ASK_ONLY price is capped at 3x its last-3 sales of any age, marked …_histcap (2026-10-29). Scoped by measurement — Top Shot has no _salescap arm. The name predates the Golazos and Top Shot arms.';

CREATE TABLE IF NOT EXISTS public.audit_20261104_topshot_ask_only_recent_histcap_backup (
  snapshot_id uuid PRIMARY KEY,
  edition_id uuid NOT NULL,
  old_fmv_usd numeric NOT NULL,
  new_fmv_usd numeric NOT NULL,
  old_algo_version text,
  capped_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.audit_20261104_topshot_ask_only_recent_histcap_backup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_20261104_topshot_ask_only_recent_histcap_backup FROM PUBLIC, anon, authenticated;

WITH latest AS (
  SELECT DISTINCT ON (fs.edition_id) fs.id, fs.edition_id, fs.fmv_usd, fs.algo_version, fs.confidence
    FROM public.fmv_snapshots fs
   WHERE fs.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
   ORDER BY fs.edition_id, fs.computed_at DESC
), med AS (
  SELECT l.id, l.edition_id, l.fmv_usd, l.algo_version, o.m
    FROM latest l
   CROSS JOIN LATERAL (
     SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY q.price_usd) AS m
       FROM (SELECT y.price_usd FROM public.sales_market y
              WHERE y.edition_id = l.edition_id
                AND y.sold_at > now() - interval '180 days'
                AND y.price_usd > 0
                AND COALESCE(y.serial_number, 999999) > 25
              ORDER BY y.sold_at DESC LIMIT 3) q) o
   WHERE l.confidence = 'ASK_ONLY' AND l.fmv_usd IS NOT NULL
     AND o.m IS NOT NULL AND o.m > 0 AND l.fmv_usd > 3 * o.m
)
INSERT INTO public.audit_20261104_topshot_ask_only_recent_histcap_backup (snapshot_id, edition_id, old_fmv_usd, new_fmv_usd, old_algo_version)
SELECT m.id, m.edition_id, m.fmv_usd, round(3 * m.m::numeric, 2), m.algo_version
  FROM med m
ON CONFLICT (snapshot_id) DO NOTHING;

UPDATE public.fmv_snapshots fs
   SET fmv_usd = b.new_fmv_usd,
       algo_version = COALESCE(fs.algo_version, '') || '_histcap'
  FROM public.audit_20261104_topshot_ask_only_recent_histcap_backup b
 WHERE fs.id = b.snapshot_id
   AND fs.confidence = 'ASK_ONLY'
   AND fs.fmv_usd = b.old_fmv_usd;

UPDATE public.edition_fmv_current c
   SET fmv_usd = b.new_fmv_usd, refreshed_at = now()
  FROM public.audit_20261104_topshot_ask_only_recent_histcap_backup b
 WHERE c.edition_id = b.edition_id
   AND c.confidence = 'ASK_ONLY'
   AND c.fmv_usd = b.old_fmv_usd;

DO $mig$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM public.audit_20261104_topshot_ask_only_recent_histcap_backup;
  IF n < 60 OR n > 130 THEN
    RAISE EXCEPTION 'topshot recent-sales histcap bound % rows; expected the ~93 measured', n;
  END IF;
END
$mig$;

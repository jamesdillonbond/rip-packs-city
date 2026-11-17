-- audit_20261029_topshot_ask_only_histcap — 2026-10-29 ~9:50 AM PT (Claude Code cloud; Trevor: "do what you can").
--
-- Extends 20261029163041's _histcap arm (no sale in 180 days: an ASK_ONLY price is capped at 3x the
-- median of the edition's last 3 market sales of ANY age, serial > 25) from All Day to NBA Top Shot.
-- Top Shot's 180-day _salescap arm stays OFF (#208 measured it as not a win there).
-- Measured the same way as All Day (120 d, sales serial > 25 whose snapshot in force >= 1 d before was
-- ASK_ONLY with no 180-d sale but an older one): older 60 d n 94: 2 moved, within +/-25 33.0 = 33.0,
-- ratio 1.41 =, WAPE 62.2 -> 59.0; recent 60 d n 72: 6 moved, within +/-25 18.1 -> 19.4, ratio
-- 2.04 -> 1.99, WAPE 95.8 -> 93.9. Never worse in any cell. Today it binds on ~24 latest Top Shot rows
-- (3 above 10x). Cost: one indexed sales_market read per Top Shot ASK_ONLY insert (~578/day).
--
-- anon-exec: intentional — trigger function (RETURNS trigger), never callable through PostgREST; EXECUTE already revoked from PUBLIC/anon/authenticated in 20261023045044 and CREATE OR REPLACE keeps the ACL (fmv_snapshots_cap_allday_ask_only_to_recent_sales)
--
-- REVERT: re-apply the function body in 20261029163041, then
--   UPDATE public.fmv_snapshots f SET fmv_usd = b.old_fmv_usd, algo_version = b.old_algo_version
--     FROM public.audit_20261029_topshot_ask_only_histcap_backup b WHERE f.id = b.snapshot_id;

DO $guard$
BEGIN
  IF (SELECT md5(trim(regexp_replace(prosrc, '\s+', ' ', 'g'))) FROM pg_proc
       WHERE oid = 'public.fmv_snapshots_cap_allday_ask_only_to_recent_sales()'::regprocedure)
     <> '97355612d5c2a0757a1eccfed4c78270' THEN
    RAISE EXCEPTION 'live body is not the 20261029163041 body this migration was written against; re-read it';
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
  -- NBA Top Shot: in the _histcap arm only (2026-10-29); its _salescap arm stays off by measurement.
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
  'BEFORE INSERT guard on fmv_snapshots: an NFL All Day (2026-10-22) or LaLiga Golazos (2026-10-23) ASK_ONLY fmv_usd is capped at the median of the edition''s last 3 market sales within 180 days (serial > 25), marked algo_version …_salescap. With no sale in 180 days, an All Day or Top Shot ASK_ONLY price is capped at 3x its last-3 sales of any age, marked …_histcap (2026-10-29). Scoped by measurement — Top Shot has no _salescap arm. The name predates the Golazos and Top Shot arms.';

CREATE TABLE IF NOT EXISTS public.audit_20261029_topshot_ask_only_histcap_backup (
  snapshot_id uuid PRIMARY KEY,
  edition_id uuid NOT NULL,
  old_fmv_usd numeric NOT NULL,
  new_fmv_usd numeric NOT NULL,
  old_algo_version text,
  capped_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.audit_20261029_topshot_ask_only_histcap_backup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_20261029_topshot_ask_only_histcap_backup FROM PUBLIC, anon, authenticated;

WITH latest AS (
  SELECT DISTINCT ON (fs.edition_id) fs.id, fs.edition_id, fs.fmv_usd, fs.algo_version, fs.confidence
    FROM public.fmv_snapshots fs
   WHERE fs.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
   ORDER BY fs.edition_id, fs.computed_at DESC
), hist AS (
  SELECT l.id, l.edition_id, l.fmv_usd, l.algo_version, o.h
    FROM latest l
   CROSS JOIN LATERAL (
     SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY q.price_usd) AS h
       FROM (SELECT y.price_usd FROM public.sales_market y
              WHERE y.edition_id = l.edition_id
                AND y.price_usd > 0
                AND COALESCE(y.serial_number, 999999) > 25
              ORDER BY y.sold_at DESC LIMIT 3) q) o
   WHERE l.confidence = 'ASK_ONLY'
     AND NOT EXISTS (SELECT 1 FROM public.sales_market y
                      WHERE y.edition_id = l.edition_id
                        AND y.sold_at > now() - interval '180 days'
                        AND y.price_usd > 0
                        AND COALESCE(y.serial_number, 999999) > 25)
     AND o.h IS NOT NULL AND o.h > 0 AND l.fmv_usd > 3 * o.h
)
INSERT INTO public.audit_20261029_topshot_ask_only_histcap_backup (snapshot_id, edition_id, old_fmv_usd, new_fmv_usd, old_algo_version)
SELECT h.id, h.edition_id, h.fmv_usd, round(3 * h.h::numeric, 2), h.algo_version
  FROM hist h
ON CONFLICT (snapshot_id) DO NOTHING;

UPDATE public.fmv_snapshots fs
   SET fmv_usd = b.new_fmv_usd,
       algo_version = COALESCE(fs.algo_version, '') || '_histcap'
  FROM public.audit_20261029_topshot_ask_only_histcap_backup b
 WHERE fs.id = b.snapshot_id
   AND fs.confidence = 'ASK_ONLY'
   AND fs.fmv_usd = b.old_fmv_usd;

DO $mig$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM public.audit_20261029_topshot_ask_only_histcap_backup;
  IF n < 1 OR n > 80 THEN
    RAISE EXCEPTION 'topshot histcap bound % rows; expected the ~24 measured', n;
  END IF;
END
$mig$;

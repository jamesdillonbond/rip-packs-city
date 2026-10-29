-- audit_20261029_allday_ask_only_histcap — 2026-10-29 ~9:30 AM PT (Claude Code cloud; Trevor: "do what you can").
--
-- Found by an HTML sweep of /insights/allday-pack-reality: "Wild Card Weekend: Premium Chance" read a
-- realised average of $89.74 against a $1.05 model (85x), median $3.52. Cause: Drake Maye — Wild Card
-- Weekend Gold (Parallel), /50 RARE, priced $7,200 ASK_ONLY (cold-tail-1.0: an $8,000 ask x 0.90). It has
-- 12 recorded sales at $27-48, the newest 2026-03-08, so #208's cap (last 3 sales within 180 days) never
-- engaged, and 29 pack pulls carried a $7,200 moment. v_fmv_sanity_flags is Top Shot-only and flags only
-- under-pricing, so nothing saw it.
--
-- Rule: an NFL All Day ASK_ONLY price with NO sale in 180 days is capped at 3x the median of the
-- edition's last 3 market sales of ANY age (serial > 25), marked _histcap. 3x is the house's existing
-- out-of-band bound (Recent-Low Totals ignore a recent low above 3x FMV). The 180-day _salescap arm is
-- unchanged and wins whenever a recent sale exists. Golazos is NOT in the new arm (not measured).
-- Backtest, 120 d, All Day sales (serial > 25) whose snapshot in force >= 1 d before was ASK_ONLY with no
-- 180-d sale but an older one: older 60 d n 44: 0 moved, identical (52.3 % within +/-25, ratio 1.18,
-- WAPE 70.1); recent 60 d n 102: within +/-25 33.3 -> 34.3, ratio 1.77 -> 1.71, WAPE 191.8 -> 101.5.
-- Never worse in any cell. (1x loses within +/-25 in the recent half; 10x leaves WAPE at 109.8.)
-- Today it binds on 9 latest rows: Drake Maye $7,200 -> $114, the rest $9-$359 trimmed.
-- Their 52 allday_pack_pull rows are touched so rollup_allday_rip_pull_value re-prices those packs.
--
-- anon-exec: intentional — trigger function (RETURNS trigger), never callable through PostgREST; EXECUTE already revoked from PUBLIC/anon/authenticated in 20261023045044 and CREATE OR REPLACE keeps the ACL (fmv_snapshots_cap_allday_ask_only_to_recent_sales)
--
-- REVERT: re-apply the function body in 20261023134231, then
--   UPDATE public.fmv_snapshots f SET fmv_usd = b.old_fmv_usd, algo_version = b.old_algo_version
--     FROM public.audit_20261029_allday_ask_only_histcap_backup b WHERE f.id = b.snapshot_id;
--   UPDATE public.allday_pack_pull SET updated_at = now()
--    WHERE edition_id IN (SELECT edition_id FROM public.audit_20261029_allday_ask_only_histcap_backup);

DO $guard$
BEGIN
  IF (SELECT md5(trim(regexp_replace(prosrc, '\s+', ' ', 'g'))) FROM pg_proc
       WHERE oid = 'public.fmv_snapshots_cap_allday_ask_only_to_recent_sales()'::regprocedure)
     <> '30a2216ec25504b50a77aa7d083e354f' THEN
    RAISE EXCEPTION 'live body is not the 20261023134231 body this migration was written against; re-read it';
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
  v_med numeric;
  v_hist numeric;
BEGIN
  IF NEW.collection_id IN (c_allday, c_golazos)
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
    IF v_med IS NOT NULL AND v_med > 0 AND NEW.fmv_usd > v_med THEN
      NEW.fmv_usd := round(v_med, 2);
      NEW.algo_version := COALESCE(NEW.algo_version, '') || '_salescap';
    ELSIF v_med IS NULL AND NEW.collection_id = c_allday THEN
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
  'BEFORE INSERT guard on fmv_snapshots: an NFL All Day (2026-10-22) or LaLiga Golazos (2026-10-23) ASK_ONLY fmv_usd is capped at the median of the edition''s last 3 market sales within 180 days (serial > 25), marked algo_version …_salescap. With no sale in 180 days, an All Day ASK_ONLY price is capped at 3x its last-3 sales of any age, marked …_histcap (2026-10-29). Scoped by measurement — not Top Shot. The name predates the Golazos arm.';

CREATE TABLE IF NOT EXISTS public.audit_20261029_allday_ask_only_histcap_backup (
  snapshot_id uuid PRIMARY KEY,
  edition_id uuid NOT NULL,
  old_fmv_usd numeric NOT NULL,
  new_fmv_usd numeric NOT NULL,
  old_algo_version text,
  capped_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.audit_20261029_allday_ask_only_histcap_backup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_20261029_allday_ask_only_histcap_backup FROM PUBLIC, anon, authenticated;

WITH latest AS (
  SELECT DISTINCT ON (fs.edition_id) fs.id, fs.edition_id, fs.fmv_usd, fs.algo_version, fs.confidence
    FROM public.fmv_snapshots fs
   WHERE fs.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'
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
INSERT INTO public.audit_20261029_allday_ask_only_histcap_backup (snapshot_id, edition_id, old_fmv_usd, new_fmv_usd, old_algo_version)
SELECT h.id, h.edition_id, h.fmv_usd, round(3 * h.h::numeric, 2), h.algo_version
  FROM hist h
ON CONFLICT (snapshot_id) DO NOTHING;

UPDATE public.fmv_snapshots fs
   SET fmv_usd = b.new_fmv_usd,
       algo_version = COALESCE(fs.algo_version, '') || '_histcap'
  FROM public.audit_20261029_allday_ask_only_histcap_backup b
 WHERE fs.id = b.snapshot_id
   AND fs.confidence = 'ASK_ONLY'
   AND fs.fmv_usd = b.old_fmv_usd;

UPDATE public.allday_pack_pull p
   SET updated_at = now()
 WHERE p.edition_id IN (SELECT b.edition_id FROM public.audit_20261029_allday_ask_only_histcap_backup b);

DO $mig$
DECLARE n int; v numeric;
BEGIN
  SELECT count(*) INTO n FROM public.audit_20261029_allday_ask_only_histcap_backup;
  IF n < 1 OR n > 30 THEN
    RAISE EXCEPTION 'histcap bound % rows; expected the ~9 measured', n;
  END IF;
  SELECT fs.fmv_usd INTO v FROM public.fmv_snapshots fs
   WHERE fs.edition_id = '3f3f70de-a052-4aa7-980a-bf26cedcea6d'
   ORDER BY fs.computed_at DESC LIMIT 1;
  IF v IS NULL OR v > 200 THEN
    RAISE EXCEPTION 'Drake Maye Wild Card Weekend Gold still priced at %', v;
  END IF;
END
$mig$;

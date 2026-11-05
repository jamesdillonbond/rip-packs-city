-- audit_20261104_topshot_ask_only_last_sale_cap — 2026-11-04 ~6:40 PM PT (Claude Code cloud; Trevor: "We need to get
-- confidence on pricing. That's the anchor of everything we do.").
--
-- A Top Shot ASK_ONLY price (ask x 0.90) on an edition WITH a market sale in the last 180 days is capped at that
-- edition's LAST market sale (serial > 25, sales_market = buy-backs excluded), marked _salescap — the suffix
-- lib/fmv-basis.ts / lib/fmv-capped.ts / get_edition_detail.basis_capped already render as "capped at sales".
-- It only ever LOWERS a price. Replaces the 3x bound added at 5:39 PM PT today (20261105014011): a last-sale cap
-- is always at or under it. The no-180-day-sale _histcap arm (20261029163623) and the All Day / Golazos arms are
-- unchanged.
--
-- Why now, against #208's "not a win on Top Shot" (10-22): that read was 7 days, and #208 itself records Top
-- Shot's 30-day read as contaminated by the frozen-parallel-ask defect fixed 10-21/22. Re-measured on CLEAN
-- sales only (sales_market, sold >= 2026-10-23 PT, serial > 25, the ASK_ONLY snapshot in force >= 1 day before
-- the sale, a market sale in the 180 days before it): n 479, 312 moved —
--   within +/-25 %: published 48.4 -> last-sale cap 56.6 (last-3 median cap 52.4)
--   median ratio:   1.21 -> 1.00          WAPE: 0.62 -> 0.45
-- by last-sale band (n / within +/-25 published -> capped / WAPE):
--   < $10   379: 49.9 -> 57.3, 0.42 -> 0.28     $10-50  65: 47.7 -> 61.5, 0.42 -> 0.28
--   $50-200  24: 41.7 -> 41.7, 0.55 -> 0.32     $200+   11: 18.2 -> 36.4, 0.84 -> 0.70
-- never worse in any band. A 45-day read (including the contaminated weeks) agrees: 41.3 -> 53.1, 1.35 -> 1.00.
-- Sized 2026-11-04 ~6:35 PM PT: 2,083 latest Top Shot ASK_ONLY rows have a 180-day sale; 1,634 sit above it,
-- $122,283 -> $74,392 summed (median cut 1.54x, largest $4,398).
--
-- Cost: one more indexed LIMIT 1 read per Top Shot ASK_ONLY insert that has a 180-day sale (v_med already read).
-- The re-price also writes edition_fmv_current: its incremental refresh windows on computed_at, which an
-- in-place UPDATE does not move.
--
-- anon-exec: intentional — trigger function (RETURNS trigger), never callable through PostgREST; EXECUTE already revoked from PUBLIC/anon/authenticated in 20261023045044 and CREATE OR REPLACE keeps the ACL (fmv_snapshots_cap_allday_ask_only_to_recent_sales)
--
-- REVERT: re-apply the function body in 20261105014011, then
--   UPDATE public.fmv_snapshots f SET fmv_usd = b.old_fmv_usd, algo_version = b.old_algo_version
--     FROM public.audit_20261104_topshot_ask_only_last_sale_cap_backup b WHERE f.id = b.snapshot_id;
--   UPDATE public.edition_fmv_current c SET fmv_usd = b.old_fmv_usd
--     FROM public.audit_20261104_topshot_ask_only_last_sale_cap_backup b
--    WHERE c.edition_id = b.edition_id AND c.fmv_usd = b.new_fmv_usd;

DO $guard$
BEGIN
  IF (SELECT md5(trim(regexp_replace(prosrc, '\s+', ' ', 'g'))) FROM pg_proc
       WHERE oid = 'public.fmv_snapshots_cap_allday_ask_only_to_recent_sales()'::regprocedure)
     <> '0df99c6e86fb779c0d294050694b6b8d' THEN
    RAISE EXCEPTION 'live body is not the 20261105014011 body this migration was written against; re-read it';
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
  -- NBA Top Shot: with a 180-day sale, capped at its LAST market sale (_salescap, 2026-11-04 evening, measured on
  -- clean post-10-23 sales); with only older sales, the _histcap 3x bound (2026-10-29).
  c_topshot constant uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_med numeric;
  v_hist numeric;
  v_last numeric;
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
    ELSIF NEW.collection_id = c_topshot AND v_med IS NOT NULL THEN
      -- 2026-11-04 evening: Top Shot WITH a 180-day sale is capped at the edition's LAST market sale. The
      -- earlier "not a win" (#208, 10-22) read Top Shot through the frozen-parallel-ask defect fixed 10-21/22;
      -- on clean sales since 10-23 (n 479, 312 moved) min(ask price, last sale) beats the published ask price
      -- on every axis and in every price band: within +/-25 48.4 -> 56.6 %, median ratio 1.21 -> 1.00, WAPE
      -- 0.62 -> 0.45. Supersedes the 3x bound of 20261105014011 (a last-sale cap is always at or under it).
      SELECT y.price_usd
        INTO v_last
        FROM public.sales_market y
       WHERE y.edition_id = NEW.edition_id
         AND y.sold_at > now() - interval '180 days'
         AND y.price_usd > 0
         AND COALESCE(y.serial_number, 999999) > 25
       ORDER BY y.sold_at DESC
       LIMIT 1;
      IF v_last IS NOT NULL AND v_last > 0 AND NEW.fmv_usd > v_last THEN
        NEW.fmv_usd := round(v_last, 2);
        NEW.algo_version := COALESCE(NEW.algo_version, '') || '_salescap';
      END IF;
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
  'BEFORE INSERT guard on fmv_snapshots: an NFL All Day (2026-10-22) or LaLiga Golazos (2026-10-23) ASK_ONLY fmv_usd is capped at the median of the edition''s last 3 market sales within 180 days (serial > 25), marked algo_version …_salescap. A Top Shot ASK_ONLY price with a market sale in 180 days is capped at that LAST sale, marked …_salescap (2026-11-04 evening; replaced the same day''s 3x bound). With no sale in 180 days, an All Day or Top Shot ASK_ONLY price is capped at 3x its last-3 sales of any age, marked …_histcap (2026-10-29). The name predates the Golazos and Top Shot arms.';

CREATE TABLE IF NOT EXISTS public.audit_20261104_topshot_ask_only_last_sale_cap_backup (
  snapshot_id uuid PRIMARY KEY,
  edition_id uuid NOT NULL,
  old_fmv_usd numeric NOT NULL,
  new_fmv_usd numeric NOT NULL,
  old_algo_version text,
  capped_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.audit_20261104_topshot_ask_only_last_sale_cap_backup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_20261104_topshot_ask_only_last_sale_cap_backup FROM PUBLIC, anon, authenticated;

WITH latest AS (
  SELECT DISTINCT ON (fs.edition_id) fs.id, fs.edition_id, fs.fmv_usd, fs.algo_version, fs.confidence
    FROM public.fmv_snapshots fs
   WHERE fs.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
   ORDER BY fs.edition_id, fs.computed_at DESC
), lst AS (
  SELECT l.id, l.edition_id, l.fmv_usd, l.algo_version, o.p
    FROM latest l
   CROSS JOIN LATERAL (
     SELECT y.price_usd AS p FROM public.sales_market y
      WHERE y.edition_id = l.edition_id
        AND y.sold_at > now() - interval '180 days'
        AND y.price_usd > 0
        AND COALESCE(y.serial_number, 999999) > 25
      ORDER BY y.sold_at DESC LIMIT 1) o
   WHERE l.confidence = 'ASK_ONLY' AND l.fmv_usd IS NOT NULL
     AND o.p IS NOT NULL AND o.p > 0 AND l.fmv_usd > o.p
)
INSERT INTO public.audit_20261104_topshot_ask_only_last_sale_cap_backup (snapshot_id, edition_id, old_fmv_usd, new_fmv_usd, old_algo_version)
SELECT x.id, x.edition_id, x.fmv_usd, round(x.p::numeric, 2), x.algo_version
  FROM lst x
ON CONFLICT (snapshot_id) DO NOTHING;

UPDATE public.fmv_snapshots fs
   SET fmv_usd = b.new_fmv_usd,
       algo_version = COALESCE(fs.algo_version, '') || '_salescap'
  FROM public.audit_20261104_topshot_ask_only_last_sale_cap_backup b
 WHERE fs.id = b.snapshot_id
   AND fs.confidence = 'ASK_ONLY'
   AND fs.fmv_usd = b.old_fmv_usd;

UPDATE public.edition_fmv_current c
   SET fmv_usd = b.new_fmv_usd, refreshed_at = now()
  FROM public.audit_20261104_topshot_ask_only_last_sale_cap_backup b
 WHERE c.edition_id = b.edition_id
   AND c.confidence = 'ASK_ONLY'
   AND c.fmv_usd = b.old_fmv_usd;

DO $mig$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM public.audit_20261104_topshot_ask_only_last_sale_cap_backup;
  IF n < 1000 OR n > 2600 THEN
    RAISE EXCEPTION 'topshot last-sale cap bound % rows; expected the ~1,634 measured 11-04 6:35 PM PT', n;
  END IF;
END
$mig$;

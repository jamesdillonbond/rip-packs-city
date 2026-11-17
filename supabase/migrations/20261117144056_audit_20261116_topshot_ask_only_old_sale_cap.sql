-- audit_20261116_topshot_ask_only_old_sale_cap — 2026-11-16 ~7:00 PM PT (Claude Code cloud; Trevor: "Keep working
-- through anything unresolved from this thread").
-- APPLIED 2026-11-17 ~6:45 AM PT on Trevor's go ("Approve and proceed"), Claude Code cloud; re-sized just before:
-- 151 rows, $37,623.78 -> $21,073.88 (inside the 100-260 bound below). Rows are also recorded in fmv_restatements (#233).
--
-- A Top Shot ASK_ONLY price with NO market sale in 180 days is now capped at the edition's LAST market sale of any
-- age (serial > 25, sales_market), marked _histcap — the same rule the 180-day arm has used since 2026-11-04 (_salescap).
-- It replaces, for Top Shot only, the 2026-10-29 bound of 3x the last-3 median.
--
-- Why: the two arms met at a CLIFF. Jokic Cosmic Legendary /49 (8:37): last market sale $2,199 (2026-05-19), lowest
-- ask $10,000 throughout. 11-09 (172 days): capped at $2,199. 11-16 (181 days): the 3x arm, 3 x $2,500 = $7,500 —
-- the published price tripled with no trade, no ask change. Found by the concierge's first live compare_collections
-- answer (roham's Jokic at $7,500, $2,199 on /trades/compare earlier the same day).
--
-- Measured 2026-11-16 ~6:50 PM PT: every Top Shot ASK_ONLY snapshot since 10-29 still in force >= 1 day before the
-- edition's next market sale (serial > 25), restricted to those whose last sale was > 180 days old: n 32, 14 moved.
--   within +/-25 %: published 43.8 -> last-sale cap 53.1      median ratio: 1.44 -> 1.20      WAPE: 0.52 -> 0.39
--   12 of the 14 moved closer, 2 further; summed published $5,038 / capped $4,545 / realised $3,410.
-- Small, and consistent with 11-04's 180-day read (n 479: 48.4 -> 56.6, 1.21 -> 1.00) and #209's stale read
-- ("never worse by last-sale age"). All Day keeps its 3x arm: not measured here.
--
-- Sized 2026-11-16 ~6:55 PM PT: 170 latest Top Shot ASK_ONLY rows with no 180-day sale sit above their last sale;
-- $45,313 -> $27,427 summed (median cut 1.50x, largest $5,301 — the Jokic row). A row carrying _bidfloor (held UP
-- to a live offer) is left alone: the offer floor is the later, stronger fact.
--
-- anon-exec: intentional — trigger function (RETURNS trigger), never callable through PostgREST; EXECUTE already revoked from PUBLIC/anon/authenticated in 20261023045044 and CREATE OR REPLACE keeps the ACL (fmv_snapshots_cap_allday_ask_only_to_recent_sales)
--
-- REVERT: re-apply the function body in 20261105024000, then
--   UPDATE public.fmv_snapshots f SET fmv_usd = b.old_fmv_usd, algo_version = b.old_algo_version
--     FROM public.audit_20261116_topshot_ask_only_old_sale_cap_backup b WHERE f.id = b.snapshot_id;
--   UPDATE public.edition_fmv_current c SET fmv_usd = b.old_fmv_usd
--     FROM public.audit_20261116_topshot_ask_only_old_sale_cap_backup b
--    WHERE c.edition_id = b.edition_id AND c.fmv_usd = b.new_fmv_usd;
DO $guard$
BEGIN
  IF (SELECT md5(trim(regexp_replace(prosrc, '\s+', ' ', 'g'))) FROM pg_proc
       WHERE oid = 'public.fmv_snapshots_cap_allday_ask_only_to_recent_sales()'::regprocedure)
     <> '64fdb62d032f76606367e8eb1c23381a' THEN
    RAISE EXCEPTION 'live body is not the 20261105024000 body this migration was written against; re-read it';
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
  -- clean post-10-23 sales); with only older sales, capped at that LAST sale of any age (_histcap, 2026-11-16 —
  -- the 10-29 3x bound left a cliff: a price tripled the day its last sale turned 181 days old).
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
    ELSIF v_med IS NULL AND NEW.collection_id = c_topshot THEN
      -- 2026-11-16: Top Shot with no sale in 180 days is capped at its LAST market sale of ANY age, the same rule
      -- as the 180-day arm, so the cap no longer jumps when a last sale ages past 180 days (Jokic Cosmic /49:
      -- $2,199 on 11-09, $7,500 on 11-16, nothing traded). Measured on the post-10-29 ASK_ONLY snapshots whose
      -- last sale was > 180 days old, each against the next market sale (n 32, 14 moved): within +/-25
      -- 43.8 -> 53.1 %, median ratio 1.44 -> 1.20, WAPE 0.52 -> 0.39; 12 of the 14 moved closer, 2 further.
      SELECT y.price_usd
        INTO v_last
        FROM public.sales_market y
       WHERE y.edition_id = NEW.edition_id
         AND y.price_usd > 0
         AND COALESCE(y.serial_number, 999999) > 25
       ORDER BY y.sold_at DESC
       LIMIT 1;
      IF v_last IS NOT NULL AND v_last > 0 AND NEW.fmv_usd > v_last THEN
        NEW.fmv_usd := round(v_last, 2);
        NEW.algo_version := COALESCE(NEW.algo_version, '') || '_histcap';
      END IF;
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
  'BEFORE INSERT guard on fmv_snapshots: an NFL All Day (2026-10-22) or LaLiga Golazos (2026-10-23) ASK_ONLY fmv_usd is capped at the median of the edition''s last 3 market sales within 180 days (serial > 25), marked algo_version …_salescap. A Top Shot ASK_ONLY price with a market sale in 180 days is capped at that LAST sale, marked …_salescap (2026-11-04 evening); with no sale in 180 days it is capped at its LAST sale of any age, marked …_histcap (2026-11-16 — the 3x bound it replaced tripled a price the day its last sale turned 181 days old). With no sale in 180 days an All Day ASK_ONLY price is capped at 3x its last-3 sales of any age, marked …_histcap (2026-10-29). The name predates the Golazos and Top Shot arms.';

CREATE TABLE IF NOT EXISTS public.audit_20261116_topshot_ask_only_old_sale_cap_backup (
  snapshot_id uuid PRIMARY KEY,
  edition_id uuid NOT NULL,
  old_fmv_usd numeric NOT NULL,
  new_fmv_usd numeric NOT NULL,
  old_algo_version text,
  capped_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.audit_20261116_topshot_ask_only_old_sale_cap_backup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_20261116_topshot_ask_only_old_sale_cap_backup FROM PUBLIC, anon, authenticated;

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
        AND y.price_usd > 0
        AND COALESCE(y.serial_number, 999999) > 25
      ORDER BY y.sold_at DESC LIMIT 1) o
   WHERE l.confidence = 'ASK_ONLY' AND l.fmv_usd IS NOT NULL
     AND COALESCE(l.algo_version, '') NOT LIKE '%_bidfloor%'
     AND o.p IS NOT NULL AND o.p > 0 AND l.fmv_usd > o.p
     AND NOT EXISTS (
       SELECT 1 FROM public.sales_market z
        WHERE z.edition_id = l.edition_id
          AND z.sold_at > now() - interval '180 days'
          AND z.price_usd > 0
          AND COALESCE(z.serial_number, 999999) > 25)
)
INSERT INTO public.audit_20261116_topshot_ask_only_old_sale_cap_backup (snapshot_id, edition_id, old_fmv_usd, new_fmv_usd, old_algo_version)
SELECT x.id, x.edition_id, x.fmv_usd, round(x.p::numeric, 2), x.algo_version
  FROM lst x
ON CONFLICT (snapshot_id) DO NOTHING;

UPDATE public.fmv_snapshots fs
   SET fmv_usd = b.new_fmv_usd,
       algo_version = CASE WHEN COALESCE(fs.algo_version, '') LIKE '%\_histcap' THEN fs.algo_version
                           ELSE COALESCE(fs.algo_version, '') || '_histcap' END
  FROM public.audit_20261116_topshot_ask_only_old_sale_cap_backup b
 WHERE fs.id = b.snapshot_id
   AND fs.confidence = 'ASK_ONLY'
   AND fs.fmv_usd = b.old_fmv_usd;

UPDATE public.edition_fmv_current c
   SET fmv_usd = b.new_fmv_usd, refreshed_at = now()
  FROM public.audit_20261116_topshot_ask_only_old_sale_cap_backup b
 WHERE c.edition_id = b.edition_id
   AND c.confidence = 'ASK_ONLY'
   AND c.fmv_usd = b.old_fmv_usd;

DO $mig$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM public.audit_20261116_topshot_ask_only_old_sale_cap_backup;
  IF n < 100 OR n > 260 THEN
    RAISE EXCEPTION 'topshot old-sale cap bound % rows; expected the ~170 measured 11-16 6:55 PM PT', n;
  END IF;
END
$mig$;

-- #233: a rule-driven re-price is recorded so the market-cap 7-day change nets it out.
INSERT INTO public.fmv_restatements (source, collection_slug, ext_id, old_fmv_usd, new_fmv_usd, restated_at)
SELECT 'audit_20261116_topshot_ask_only_old_sale_cap', 'nba_top_shot', e.external_id, b.old_fmv_usd, b.new_fmv_usd, now()
  FROM public.audit_20261116_topshot_ask_only_old_sale_cap_backup b
  JOIN public.editions e ON e.id = b.edition_id
ON CONFLICT (source, collection_slug, ext_id) DO NOTHING;

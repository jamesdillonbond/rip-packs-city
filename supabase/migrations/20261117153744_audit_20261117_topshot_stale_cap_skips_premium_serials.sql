-- audit_20261117_topshot_stale_cap_skips_premium_serials — 2026-11-17 ~8:00 AM PT (Claude Code cloud; Trevor: "Keep
-- going", after the binder FMV thread). Extends #213 (All Day, 2026-11-05) to NBA Top Shot.
--
-- fmv_snapshots_cap_stale_to_last_sale() caps a STALE price at the edition's last market sale, counting only serial
-- > 25 — except on an All Day edition of circulation <= 50, where it skips just the premium serials (#1, the jersey
-- number, the last mint). Top Shot kept serial > 25, so a /28 Top Shot edition (no serial above 25) was never
-- capped. Now both collections use the premium-serial rule at circulation <= 50.
--
-- Measured 2026-11-17 ~7:50 AM PT: every Top Shot STALE snapshot on a circulation <= 50 edition in the last 180 days,
-- the last one in force >= 1 day before each next non-premium market sale, n 597, 381 moved:
--   within +/-25 %: published 26.1 -> capped 38.5    median ratio: 1.70 -> 1.25    WAPE: 1.28 -> 0.49
--   322 of the 381 moved closer, 59 further.
-- Sized (edition_fmv_current, same minute): 63 current Top Shot STALE rows move, $30,672 -> $23,778.
--
-- anon-exec: intentional — trigger function (RETURNS trigger), never callable through PostgREST; CREATE OR REPLACE keeps the existing ACL (fmv_snapshots_cap_stale_to_last_sale)
--
-- REVERT: re-apply the function body in 20261105213600, then
--   UPDATE public.edition_fmv_current c SET fmv_usd = b.old_fmv_usd
--     FROM public.audit_20261117_topshot_stale_cap_low_mint_backup b
--    WHERE c.edition_id = b.edition_id AND c.fmv_usd = b.new_fmv_usd;
--   UPDATE public.fmv_snapshots f SET fmv_usd = b.old_fmv_usd, algo_version = b.old_algo_version
--     FROM public.audit_20261117_topshot_stale_cap_low_mint_backup b
--    WHERE f.id = b.snapshot_id AND f.fmv_usd = b.new_fmv_usd;
--   DELETE FROM public.fmv_restatements WHERE source = 'audit_20261117_topshot_stale_cap_skips_premium_serials';
DO $guard$
BEGIN
  IF (SELECT md5(trim(regexp_replace(prosrc, '\s+', ' ', 'g'))) FROM pg_proc
       WHERE oid = 'public.fmv_snapshots_cap_stale_to_last_sale()'::regprocedure)
     <> '4bc00ba880853f73dd80a6e3a9d7456c' THEN
    RAISE EXCEPTION 'live body is not the 20261105213600 body this migration was written against; re-read it';
  END IF;
END
$guard$;
CREATE OR REPLACE FUNCTION public.fmv_snapshots_cap_stale_to_last_sale()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  -- NBA Top Shot and NFL All Day (collections.id). Scoped by measurement (2026-10-23, #209).
  c_topshot constant uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  c_allday  constant uuid := 'dee28451-5d62-409e-a1ad-a83f763ac070';
  v_last numeric;
  v_circ integer;
  v_jersey integer;
BEGIN
  IF NEW.collection_id IN (c_topshot, c_allday)
     AND NEW.confidence = 'STALE'
     AND NEW.fmv_usd IS NOT NULL
     AND NEW.edition_id IS NOT NULL
  THEN
    -- 2026-11-17: Top Shot too (was All Day only) — a /28 Top Shot edition has no serial above 25, so its
    -- STALE price was never capped (backtest circ <= 50, n 597: within +/-25 26.1 -> 38.5, WAPE 1.28 -> 0.49).
    IF NEW.collection_id IN (c_allday, c_topshot) THEN
      SELECT e.circulation_count, e.jersey_number INTO v_circ, v_jersey
        FROM public.editions e WHERE e.id = NEW.edition_id;
    END IF;

    IF v_circ IS NOT NULL AND v_circ <= 50 THEN
      -- 2026-11-05 (#213): on a small All Day edition, skip only the PREMIUM serials
      -- (#1, the jersey number, the last mint) — serial > 25 ignores most of the supply.
      SELECT y.price_usd
        INTO v_last
        FROM public.sales_market y
       WHERE y.edition_id = NEW.edition_id
         AND y.price_usd > 0
         AND y.serial_number IS DISTINCT FROM 1
         AND y.serial_number IS DISTINCT FROM v_jersey
         AND y.serial_number IS DISTINCT FROM v_circ
       ORDER BY y.sold_at DESC
       LIMIT 1;
    ELSE
      SELECT y.price_usd
        INTO v_last
        FROM public.sales_market y
       WHERE y.edition_id = NEW.edition_id
         AND y.price_usd > 0
         AND COALESCE(y.serial_number, 999999) > 25
       ORDER BY y.sold_at DESC
       LIMIT 1;
    END IF;

    IF v_last IS NOT NULL AND v_last > 0 AND NEW.fmv_usd > v_last THEN
      NEW.fmv_usd := round(v_last, 2);
      NEW.algo_version := COALESCE(NEW.algo_version, '') || '_stalecap';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TABLE IF NOT EXISTS public.audit_20261117_topshot_stale_cap_low_mint_backup (
  edition_id uuid PRIMARY KEY,
  snapshot_id uuid,
  old_fmv_usd numeric NOT NULL,
  new_fmv_usd numeric NOT NULL,
  old_algo_version text,
  capped_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.audit_20261117_topshot_stale_cap_low_mint_backup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_20261117_topshot_stale_cap_low_mint_backup FROM PUBLIC, anon, authenticated;

WITH cur AS (
  SELECT c.edition_id, c.fmv_usd, e.circulation_count AS circ, e.jersey_number AS jersey
    FROM public.edition_fmv_current c
    JOIN public.editions e ON e.id = c.edition_id
   WHERE c.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
     AND c.confidence = 'STALE' AND c.fmv_usd IS NOT NULL
     AND e.circulation_count <= 50
), lst AS (
  SELECT cur.edition_id, cur.fmv_usd, o.p
    FROM cur
   CROSS JOIN LATERAL (
     SELECT y.price_usd AS p FROM public.sales_market y
      WHERE y.edition_id = cur.edition_id
        AND y.price_usd > 0
        AND y.serial_number IS DISTINCT FROM 1
        AND y.serial_number IS DISTINCT FROM cur.jersey
        AND y.serial_number IS DISTINCT FROM cur.circ
      ORDER BY y.sold_at DESC LIMIT 1) o
   WHERE o.p > 0 AND cur.fmv_usd > o.p
), snap AS (
  SELECT DISTINCT ON (fs.edition_id) fs.edition_id, fs.id, fs.fmv_usd, fs.algo_version, fs.confidence
    FROM public.fmv_snapshots fs
   WHERE fs.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
     AND fs.edition_id IN (SELECT edition_id FROM lst)
   ORDER BY fs.edition_id, fs.computed_at DESC
)
INSERT INTO public.audit_20261117_topshot_stale_cap_low_mint_backup (edition_id, snapshot_id, old_fmv_usd, new_fmv_usd, old_algo_version)
SELECT l.edition_id,
       CASE WHEN s.confidence = 'STALE' AND s.fmv_usd = l.fmv_usd THEN s.id END,
       l.fmv_usd, round(l.p::numeric, 2), s.algo_version
  FROM lst l
  LEFT JOIN snap s ON s.edition_id = l.edition_id
ON CONFLICT (edition_id) DO NOTHING;

UPDATE public.fmv_snapshots fs
   SET fmv_usd = b.new_fmv_usd,
       algo_version = CASE WHEN COALESCE(fs.algo_version, '') LIKE '%\_stalecap' THEN fs.algo_version
                           ELSE COALESCE(fs.algo_version, '') || '_stalecap' END
  FROM public.audit_20261117_topshot_stale_cap_low_mint_backup b
 WHERE fs.id = b.snapshot_id
   AND fs.confidence = 'STALE'
   AND fs.fmv_usd = b.old_fmv_usd;

UPDATE public.edition_fmv_current c
   SET fmv_usd = b.new_fmv_usd, refreshed_at = now()
  FROM public.audit_20261117_topshot_stale_cap_low_mint_backup b
 WHERE c.edition_id = b.edition_id
   AND c.confidence = 'STALE'
   AND c.fmv_usd = b.old_fmv_usd;

INSERT INTO public.fmv_restatements (source, collection_slug, ext_id, old_fmv_usd, new_fmv_usd, restated_at)
SELECT 'audit_20261117_topshot_stale_cap_skips_premium_serials', 'nba_top_shot', e.external_id, b.old_fmv_usd, b.new_fmv_usd, now()
  FROM public.audit_20261117_topshot_stale_cap_low_mint_backup b
  JOIN public.editions e ON e.id = b.edition_id
ON CONFLICT (source, collection_slug, ext_id) DO NOTHING;

DO $mig$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM public.audit_20261117_topshot_stale_cap_low_mint_backup;
  IF n < 40 OR n > 120 THEN
    RAISE EXCEPTION 'topshot stale low-mint cap bound % rows; expected the ~63 measured 11-17 7:50 AM PT', n;
  END IF;
END
$mig$;

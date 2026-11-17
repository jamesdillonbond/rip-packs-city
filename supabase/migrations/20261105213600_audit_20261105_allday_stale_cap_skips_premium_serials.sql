-- audit_20261105_allday_stale_cap_skips_premium_serials — 2026-11-05 ~1:40 PM PT (Claude Code cloud; Trevor:
-- "Do what makes sense", after #213 was put to him as ship-or-close). Closes known-issues #213.
--
-- THE DEFECT. fmv_snapshots_cap_stale_to_last_sale (#209, 20261023222201) caps a Top Shot / All Day STALE price at
-- the edition's last market sale, but reads only serial > 25. On a small All Day edition most of the supply is
-- serial <= 25, so a newer, lower sale is ignored and the cap falls through to an old one. Live case:
-- /nfl-all-day/edition/1919 (Chris Jones Dynamic, /30) published $520 (a 2024 sale at #26) over a newer $69 sale
-- at #9 (2026-01-30).
--
-- THE RULE (All Day, circulation <= 50 ONLY): cap at the last sale that is not a PREMIUM serial — not #1, not the
-- jersey number, not the last mint (#N/N). Everywhere else the serial > 25 rule is unchanged.
--
-- WHY THIS SCOPE (the decision). Backtest re-run 2026-11-05 ~11:41 AM PT (known-issues #213): All Day, 120 d,
-- realised sales excluding premium serials, published STALE snapshot in force >= 1 d before, A = today's cap vs
-- B = this rule. Circulation <= 50: older half n 17 within +/-25 % 17.6 = 17.6, WAPE 276.0 -> 225.8, median ratio
-- 2.05 = 2.05; recent half n 36 within 13.9 -> 16.7, WAPE 360.6 -> 328.4, ratio 3.56 -> 3.06 — wins or ties EVERY
-- cell in BOTH halves (the house rule), the same direction as the 10-25 / 10-29 / 10-30 reads. Circulation > 50
-- lost one hit-rate sale in the recent half (30.4 -> 29.3, 1 of 92) with the ratio drifting 1.12 -> 1.21, so it is
-- left out. Top Shot is left out (its 10-25 read lost the gate metric; a TS premium-serial read is still owed).
-- The item's >= 60 moved-sales bar was not met (10 moved in this scope): accepted under Trevor's delegation because
-- the rule can only LOWER a stale price to a real, more recent sale of the same edition, every read since 10-25
-- points the same way, and the defect is visible on pages collectors reach.
--
-- ONE-TIME RE-PRICE. The trigger is BEFORE INSERT, and STALE rows are rewritten rarely (1919's newest snapshot is
-- 10-30), so existing latest STALE rows in scope are re-priced here, backed up first: 176 editions read 11-05
-- ~1:35 PM PT ($42,159 -> $24,946; 174 of them via a sale at serial <= 25). Each is logged in fmv_restatements so
-- the market-cap 7-day change nets it out (#233).
--
-- anon-exec: unchanged (fmv_snapshots_cap_stale_to_last_sale) — CREATE OR REPLACE of the same trigger function; ACL preserved, verified anon=false 11-05.
--
-- REVERT:
--   re-apply the function body in 20261023222201;
--   UPDATE public.fmv_snapshots f SET fmv_usd = b.old_fmv_usd, algo_version = b.old_algo_version
--     FROM public.audit_20261105_allday_stale_premium_serial_backup b WHERE f.id = b.snapshot_id;
--   UPDATE public.edition_fmv_current c SET fmv_usd = b.old_fmv_usd, refreshed_at = now()
--     FROM public.audit_20261105_allday_stale_premium_serial_backup b
--    WHERE c.edition_id = b.edition_id AND c.fmv_usd = b.new_fmv_usd;
--   DELETE FROM public.fmv_restatements WHERE source = 'audit_20261105_allday_stale_cap_skips_premium_serials';

DO $guard$
BEGIN
  IF (SELECT md5(trim(regexp_replace(prosrc, '\s+', ' ', 'g'))) FROM pg_proc
       WHERE oid = 'public.fmv_snapshots_cap_stale_to_last_sale()'::regprocedure) <> '568a390191a00f30909c27e65a44b3ee' THEN
    RAISE EXCEPTION 'fmv_snapshots_cap_stale_to_last_sale is not the 20261023222201 body; re-read it and re-base';
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
    IF NEW.collection_id = c_allday THEN
      SELECT e.circulation_count, e.jersey_number INTO v_circ, v_jersey
        FROM public.editions e WHERE e.id = NEW.edition_id;
    END IF;

    IF NEW.collection_id = c_allday AND v_circ IS NOT NULL AND v_circ <= 50 THEN
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

-- One-time re-price of the latest STALE rows in scope (backed up first).
CREATE TABLE IF NOT EXISTS public.audit_20261105_allday_stale_premium_serial_backup (
  snapshot_id uuid PRIMARY KEY,
  edition_id uuid NOT NULL,
  external_id text NOT NULL,
  old_fmv_usd numeric NOT NULL,
  new_fmv_usd numeric NOT NULL,
  old_algo_version text,
  capped_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.audit_20261105_allday_stale_premium_serial_backup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_20261105_allday_stale_premium_serial_backup FROM PUBLIC, anon, authenticated;

WITH latest AS (
  SELECT DISTINCT ON (fs.edition_id) fs.id, fs.edition_id, fs.fmv_usd, fs.algo_version, fs.confidence
    FROM public.fmv_snapshots fs
   WHERE fs.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'
   ORDER BY fs.edition_id, fs.computed_at DESC
), cand AS (
  SELECT l.id, l.edition_id, e.external_id, l.fmv_usd, l.algo_version, o.p
    FROM latest l
    JOIN public.editions e ON e.id = l.edition_id
   CROSS JOIN LATERAL (
     SELECT y.price_usd AS p FROM public.sales_market y
      WHERE y.edition_id = l.edition_id
        AND y.price_usd > 0
        AND y.serial_number IS DISTINCT FROM 1
        AND y.serial_number IS DISTINCT FROM e.jersey_number
        AND y.serial_number IS DISTINCT FROM e.circulation_count
      ORDER BY y.sold_at DESC LIMIT 1) o
   WHERE l.confidence = 'STALE' AND l.fmv_usd IS NOT NULL
     AND e.circulation_count IS NOT NULL AND e.circulation_count <= 50
     AND o.p IS NOT NULL AND o.p > 0 AND l.fmv_usd > o.p
)
INSERT INTO public.audit_20261105_allday_stale_premium_serial_backup
       (snapshot_id, edition_id, external_id, old_fmv_usd, new_fmv_usd, old_algo_version)
SELECT c.id, c.edition_id, c.external_id, c.fmv_usd, round(c.p::numeric, 2), c.algo_version
  FROM cand c
ON CONFLICT (snapshot_id) DO NOTHING;

DO $count$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM public.audit_20261105_allday_stale_premium_serial_backup;
  IF n < 120 OR n > 260 THEN
    RAISE EXCEPTION 'All Day premium-serial stale cap bound % rows; expected the ~176 measured 11-05 1:35 PM PT', n;
  END IF;
END
$count$;

UPDATE public.fmv_snapshots fs
   SET fmv_usd = b.new_fmv_usd,
       algo_version = CASE WHEN COALESCE(fs.algo_version, '') LIKE '%\_stalecap' THEN fs.algo_version
                           ELSE COALESCE(fs.algo_version, '') || '_stalecap' END
  FROM public.audit_20261105_allday_stale_premium_serial_backup b
 WHERE fs.id = b.snapshot_id
   AND fs.confidence = 'STALE'
   AND fs.fmv_usd = b.old_fmv_usd;

UPDATE public.edition_fmv_current c
   SET fmv_usd = b.new_fmv_usd, refreshed_at = now()
  FROM public.audit_20261105_allday_stale_premium_serial_backup b
 WHERE c.edition_id = b.edition_id
   AND c.confidence = 'STALE'
   AND c.fmv_usd = b.old_fmv_usd;

INSERT INTO public.fmv_restatements (source, collection_slug, ext_id, old_fmv_usd, new_fmv_usd, restated_at)
SELECT 'audit_20261105_allday_stale_cap_skips_premium_serials', 'nfl_all_day', b.external_id,
       b.old_fmv_usd, b.new_fmv_usd, now()
  FROM public.audit_20261105_allday_stale_premium_serial_backup b
ON CONFLICT (source, collection_slug, ext_id) DO NOTHING;

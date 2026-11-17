-- audit_20261117_topshot_ask_only_low_mint_cap — 2026-11-17 ~7:20 AM PT (Claude Code cloud; Trevor, on his binder
-- screenshot: "This seems to be off" → "Yes do that").
--
-- A Top Shot edition of 28 or fewer has no serial above 25 (or only a few), so the ASK_ONLY caps' "ordinary sale"
-- filter (serial > 25) saw NO sales and every cap was skipped: the price stayed at ask x 0.90 however far below it
-- the edition traded. Lillard Run It Back: Legacies 2014-19 Legendary /28: $1,800 from a $2,000 ask; its last six
-- market sales $900-$1,011 (Jan-Sep 2025). On those editions an ordinary sale is now any serial except #1, the
-- jersey number and the last mint (the specialCats() special serials); every arm and mark is otherwise unchanged.
--
-- Measured 2026-11-17 ~7:10 AM PT: every Top Shot ASK_ONLY snapshot on a circulation <= 28 edition in the last
-- 120 days, the last one in force >= 1 day before each next ordinary-serial market sale, n 780, 420 moved:
--   within +/-25 %: published 20.6 -> capped 33.2    median ratio: 2.00 -> 1.41    WAPE: 1.54 -> 0.76
--   348 of the 420 moved closer, 72 further.
-- Sized (edition_fmv_current, same minute): 574 Top Shot ASK_ONLY editions sit above their last ordinary sale,
-- $175,058 -> $66,643, median cut 1.80x, all circulation <= 28. A _bidfloor row (held UP to a live offer) is left alone.
--
-- anon-exec: intentional — trigger function (RETURNS trigger), never callable through PostgREST; EXECUTE already revoked from PUBLIC/anon/authenticated in 20261023045044 and CREATE OR REPLACE keeps the ACL (fmv_snapshots_cap_allday_ask_only_to_recent_sales)
--
-- REVERT: re-apply the function body in 20261117144056, then
--   UPDATE public.edition_fmv_current c SET fmv_usd = b.old_fmv_usd
--     FROM public.audit_20261117_topshot_ask_only_low_mint_cap_backup b
--    WHERE c.edition_id = b.edition_id AND c.fmv_usd = b.new_fmv_usd;
--   UPDATE public.fmv_snapshots f SET fmv_usd = b.old_fmv_usd, algo_version = b.old_algo_version
--     FROM public.audit_20261117_topshot_ask_only_low_mint_cap_backup b
--    WHERE f.id = b.snapshot_id AND f.fmv_usd = b.new_fmv_usd;
--   DELETE FROM public.fmv_restatements WHERE source = 'audit_20261117_topshot_ask_only_low_mint_cap';
DO $guard$
BEGIN
  IF (SELECT md5(trim(regexp_replace(prosrc, '\s+', ' ', 'g'))) FROM pg_proc
       WHERE oid = 'public.fmv_snapshots_cap_allday_ask_only_to_recent_sales()'::regprocedure)
     <> '069d776f3563812f45b86c7c7db50685' THEN
    RAISE EXCEPTION 'live body is not the 20261117144056 body this migration was written against; re-read it';
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
  -- 2026-11-17: a Top Shot edition of 28 or fewer has NO serial above 25 (or only 1-3 of them), so the serial > 25
  -- "ordinary sale" filter saw no sales at all and every cap above was skipped (Lillard Legacies Legendary /28:
  -- published $1,800 from a $2,000 ask, its last six sales $900-$1,011). On those editions an ordinary sale is any
  -- serial except #1, the jersey number and the last mint — the same special serials as specialCats().
  v_lowmint boolean := false;
  v_circ integer;
  v_jersey integer;
BEGIN
  IF NEW.collection_id IN (c_allday, c_golazos, c_topshot)
     AND NEW.confidence = 'ASK_ONLY'
     AND NEW.fmv_usd IS NOT NULL
     AND NEW.edition_id IS NOT NULL
  THEN
    IF NEW.collection_id = c_topshot THEN
      SELECT e.circulation_count, NULLIF(e.jersey_number, 0)
        INTO v_circ, v_jersey
        FROM public.editions e
       WHERE e.id = NEW.edition_id;
      v_lowmint := v_circ IS NOT NULL AND v_circ <= 28;
    END IF;
    SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY q.price_usd)
      INTO v_med
      FROM (
        SELECT y.price_usd
          FROM public.sales_market y
         WHERE y.edition_id = NEW.edition_id
           AND y.sold_at > now() - interval '180 days'
           AND y.price_usd > 0
           AND CASE WHEN v_lowmint THEN y.serial_number IS NOT NULL AND y.serial_number <> 1
                 AND y.serial_number IS DISTINCT FROM v_jersey AND y.serial_number <> v_circ
            ELSE COALESCE(y.serial_number, 999999) > 25 END
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
         AND CASE WHEN v_lowmint THEN y.serial_number IS NOT NULL AND y.serial_number <> 1
                 AND y.serial_number IS DISTINCT FROM v_jersey AND y.serial_number <> v_circ
            ELSE COALESCE(y.serial_number, 999999) > 25 END
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
         AND CASE WHEN v_lowmint THEN y.serial_number IS NOT NULL AND y.serial_number <> 1
                 AND y.serial_number IS DISTINCT FROM v_jersey AND y.serial_number <> v_circ
            ELSE COALESCE(y.serial_number, 999999) > 25 END
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
             AND CASE WHEN v_lowmint THEN y.serial_number IS NOT NULL AND y.serial_number <> 1
                 AND y.serial_number IS DISTINCT FROM v_jersey AND y.serial_number <> v_circ
            ELSE COALESCE(y.serial_number, 999999) > 25 END
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
  'BEFORE INSERT guard on fmv_snapshots: an NFL All Day (2026-10-22) or LaLiga Golazos (2026-10-23) ASK_ONLY fmv_usd is capped at the median of the edition''s last 3 market sales within 180 days (serial > 25), marked algo_version …_salescap. A Top Shot ASK_ONLY price with a market sale in 180 days is capped at that LAST sale, marked …_salescap (2026-11-04 evening); with no sale in 180 days it is capped at its LAST sale of any age, marked …_histcap (2026-11-16). On a Top Shot edition of 28 or fewer an ordinary sale is any serial but #1, the jersey number and the last mint, not serial > 25, which saw none (2026-11-17). With no sale in 180 days an All Day ASK_ONLY price is capped at 3x its last-3 sales of any age, marked …_histcap (2026-10-29). The name predates the Golazos and Top Shot arms.';

CREATE TABLE IF NOT EXISTS public.audit_20261117_topshot_ask_only_low_mint_cap_backup (
  edition_id uuid PRIMARY KEY,
  snapshot_id uuid,
  old_fmv_usd numeric NOT NULL,
  new_fmv_usd numeric NOT NULL,
  old_algo_version text,
  capped_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.audit_20261117_topshot_ask_only_low_mint_cap_backup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_20261117_topshot_ask_only_low_mint_cap_backup FROM PUBLIC, anon, authenticated;

WITH cur AS (
  SELECT c.edition_id, c.fmv_usd, e.circulation_count AS circ, NULLIF(e.jersey_number, 0)::int AS jersey
    FROM public.edition_fmv_current c
    JOIN public.editions e ON e.id = c.edition_id
   WHERE c.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
     AND c.confidence = 'ASK_ONLY' AND c.fmv_usd IS NOT NULL
     AND e.circulation_count <= 28
), lst AS (
  SELECT cur.edition_id, cur.fmv_usd, o.p
    FROM cur
   CROSS JOIN LATERAL (
     SELECT y.price_usd AS p FROM public.sales_market y
      WHERE y.edition_id = cur.edition_id
        AND y.price_usd > 0
        AND y.serial_number IS NOT NULL AND y.serial_number <> 1
        AND y.serial_number IS DISTINCT FROM cur.jersey AND y.serial_number <> cur.circ
      ORDER BY y.sold_at DESC LIMIT 1) o
   WHERE o.p > 0 AND cur.fmv_usd > o.p
), snap AS (
  SELECT DISTINCT ON (fs.edition_id) fs.edition_id, fs.id, fs.fmv_usd, fs.algo_version, fs.confidence
    FROM public.fmv_snapshots fs
   WHERE fs.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
     AND fs.edition_id IN (SELECT edition_id FROM lst)
   ORDER BY fs.edition_id, fs.computed_at DESC
)
INSERT INTO public.audit_20261117_topshot_ask_only_low_mint_cap_backup (edition_id, snapshot_id, old_fmv_usd, new_fmv_usd, old_algo_version)
SELECT l.edition_id,
       CASE WHEN s.confidence = 'ASK_ONLY' AND s.fmv_usd = l.fmv_usd THEN s.id END,
       l.fmv_usd, round(l.p::numeric, 2), s.algo_version
  FROM lst l
  LEFT JOIN snap s ON s.edition_id = l.edition_id
 WHERE COALESCE(s.algo_version, '') NOT LIKE '%\_bidfloor%'
ON CONFLICT (edition_id) DO NOTHING;

UPDATE public.fmv_snapshots fs
   SET fmv_usd = b.new_fmv_usd,
       algo_version = COALESCE(fs.algo_version, '') || '_lowmintcap'
  FROM public.audit_20261117_topshot_ask_only_low_mint_cap_backup b
 WHERE fs.id = b.snapshot_id
   AND fs.confidence = 'ASK_ONLY'
   AND fs.fmv_usd = b.old_fmv_usd;

UPDATE public.edition_fmv_current c
   SET fmv_usd = b.new_fmv_usd, refreshed_at = now()
  FROM public.audit_20261117_topshot_ask_only_low_mint_cap_backup b
 WHERE c.edition_id = b.edition_id
   AND c.confidence = 'ASK_ONLY'
   AND c.fmv_usd = b.old_fmv_usd;

INSERT INTO public.fmv_restatements (source, collection_slug, ext_id, old_fmv_usd, new_fmv_usd, restated_at)
SELECT 'audit_20261117_topshot_ask_only_low_mint_cap', 'nba_top_shot', e.external_id, b.old_fmv_usd, b.new_fmv_usd, now()
  FROM public.audit_20261117_topshot_ask_only_low_mint_cap_backup b
  JOIN public.editions e ON e.id = b.edition_id
ON CONFLICT (source, collection_slug, ext_id) DO NOTHING;

DO $mig$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM public.audit_20261117_topshot_ask_only_low_mint_cap_backup;
  IF n < 450 OR n > 750 THEN
    RAISE EXCEPTION 'topshot low-mint cap bound % rows; expected the ~574 measured 11-17 7:10 AM PT', n;
  END IF;
END
$mig$;

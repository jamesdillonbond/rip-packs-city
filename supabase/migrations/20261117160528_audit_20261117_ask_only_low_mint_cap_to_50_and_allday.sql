-- audit_20261117_ask_only_low_mint_cap_to_50_and_allday — 2026-11-17 ~8:20 AM PT (Claude Code cloud; Trevor: "Yes do
-- it all"). Widens 20261117150011 (Top Shot circulation <= 28) to circulation <= 50 and to NFL All Day.
--
-- The ASK_ONLY caps count an "ordinary sale" as serial > 25. On an edition of 50 or fewer that ignores half or more
-- of the supply, so the cap read too few sales or none. On Top Shot and All Day editions of circulation <= 50 an
-- ordinary sale is now any serial except #1, the jersey number and the last mint — the rule the STALE cap uses for
-- both collections (#213, 20261117153744). LaLiga Golazos unchanged: no small-edition ASK_ONLY snapshot had a later
-- sale to measure against.
--
-- Measured 2026-11-17 ~8:10 AM PT: ASK_ONLY snapshots in the last 120 days, the last one in force >= 1 day before each
-- next ordinary-serial market sale, against each collection's own cap rule:
--   Top Shot circulation 29-50  n 598, 380 moved: within +/-25 26.6 -> 37.8 %, median ratio 1.69 -> 1.25,
--                                WAPE 0.77 -> 0.37; 313 closer, 66 further.
--   All Day circulation <= 50   n 373, 65 moved:  within +/-25 30.6 -> 32.7 %, median ratio 1.89 -> 1.73,
--                                WAPE 3.33 -> 1.93; 58 closer, 7 further.
-- Sized (edition_fmv_current, same minute): Top Shot 93 rows $16,838 -> $12,031; All Day 46 rows $6,890 -> $2,851.
--
-- anon-exec: intentional — trigger function (RETURNS trigger), never callable through PostgREST; EXECUTE already revoked from PUBLIC/anon/authenticated in 20261023045044 and CREATE OR REPLACE keeps the ACL (fmv_snapshots_cap_allday_ask_only_to_recent_sales)
--
-- REVERT: re-apply the function body in 20261117150011, then
--   UPDATE public.edition_fmv_current c SET fmv_usd = b.old_fmv_usd
--     FROM public.audit_20261117_ask_only_low_mint_50_backup b
--    WHERE c.edition_id = b.edition_id AND c.fmv_usd = b.new_fmv_usd;
--   UPDATE public.fmv_snapshots f SET fmv_usd = b.old_fmv_usd, algo_version = b.old_algo_version
--     FROM public.audit_20261117_ask_only_low_mint_50_backup b
--    WHERE f.id = b.snapshot_id AND f.fmv_usd = b.new_fmv_usd;
--   DELETE FROM public.fmv_restatements WHERE source = 'audit_20261117_ask_only_low_mint_cap_to_50_and_allday';
DO $guard$
BEGIN
  IF (SELECT md5(trim(regexp_replace(prosrc, '\s+', ' ', 'g'))) FROM pg_proc
       WHERE oid = 'public.fmv_snapshots_cap_allday_ask_only_to_recent_sales()'::regprocedure)
     <> 'c7ee91c0f864316afed57013e91585e1' THEN
    RAISE EXCEPTION 'live body is not the 20261117150011 body this migration was written against; re-read it';
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
  -- 2026-11-17 (later): widened to circulation <= 50 and to NFL All Day, matching the STALE cap (#213); Golazos
  -- unchanged (no measurable sample). Top Shot /29-/50 n 598: within +/-25 26.6 -> 37.8, WAPE 0.77 -> 0.37; All Day
  -- <= /50 n 373: 30.6 -> 32.7, WAPE 3.33 -> 1.93 (58 closer, 7 further).
  v_lowmint boolean := false;
  v_circ integer;
  v_jersey integer;
BEGIN
  IF NEW.collection_id IN (c_allday, c_golazos, c_topshot)
     AND NEW.confidence = 'ASK_ONLY'
     AND NEW.fmv_usd IS NOT NULL
     AND NEW.edition_id IS NOT NULL
  THEN
    IF NEW.collection_id IN (c_topshot, c_allday) THEN
      SELECT e.circulation_count, NULLIF(e.jersey_number, 0)
        INTO v_circ, v_jersey
        FROM public.editions e
       WHERE e.id = NEW.edition_id;
      v_lowmint := v_circ IS NOT NULL AND v_circ <= 50;
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
  'BEFORE INSERT guard on fmv_snapshots: an NFL All Day (2026-10-22) or LaLiga Golazos (2026-10-23) ASK_ONLY fmv_usd is capped at the median of the edition''s last 3 market sales within 180 days, marked algo_version …_salescap. A Top Shot ASK_ONLY price with a market sale in 180 days is capped at that LAST sale, marked …_salescap (2026-11-04 evening); with no sale in 180 days it is capped at its LAST sale of any age, marked …_histcap (2026-11-16). With no sale in 180 days an All Day ASK_ONLY price is capped at 3x its last-3 sales of any age, marked …_histcap (2026-10-29). A market sale counts when its serial is > 25, except on a Top Shot or All Day edition of circulation <= 50, where any serial but #1, the jersey number and the last mint counts (2026-11-17). The name predates the Golazos and Top Shot arms.';

CREATE TABLE IF NOT EXISTS public.audit_20261117_ask_only_low_mint_50_backup (
  edition_id uuid PRIMARY KEY,
  collection_id uuid NOT NULL,
  snapshot_id uuid,
  old_fmv_usd numeric NOT NULL,
  new_fmv_usd numeric NOT NULL,
  new_suffix text NOT NULL,
  old_algo_version text,
  capped_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.audit_20261117_ask_only_low_mint_50_backup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_20261117_ask_only_low_mint_50_backup FROM PUBLIC, anon, authenticated;

WITH cur AS (
  SELECT c.edition_id, c.collection_id AS cid, c.fmv_usd, e.circulation_count AS circ, NULLIF(e.jersey_number, 0)::int AS jersey
    FROM public.edition_fmv_current c
    JOIN public.editions e ON e.id = c.edition_id
   WHERE c.confidence = 'ASK_ONLY' AND c.fmv_usd > 0 AND e.circulation_count <= 50
     AND ((c.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd' AND e.circulation_count > 28)
          OR c.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070')
), w AS (
  SELECT cur.*,
    (SELECT y.price_usd FROM public.sales_market y
      WHERE y.edition_id = cur.edition_id AND y.price_usd > 0
        AND y.serial_number IS NOT NULL AND y.serial_number <> 1
        AND y.serial_number IS DISTINCT FROM cur.jersey AND y.serial_number <> cur.circ
      ORDER BY y.sold_at DESC LIMIT 1) AS last_any,
    (SELECT max(y.sold_at) FROM public.sales_market y
      WHERE y.edition_id = cur.edition_id AND y.price_usd > 0
        AND y.serial_number IS NOT NULL AND y.serial_number <> 1
        AND y.serial_number IS DISTINCT FROM cur.jersey AND y.serial_number <> cur.circ) AS last_at,
    (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY q.price_usd) FROM (
       SELECT y.price_usd FROM public.sales_market y
        WHERE y.edition_id = cur.edition_id AND y.price_usd > 0 AND y.sold_at > now() - interval '180 days'
          AND y.serial_number IS NOT NULL AND y.serial_number <> 1
          AND y.serial_number IS DISTINCT FROM cur.jersey AND y.serial_number <> cur.circ
        ORDER BY y.sold_at DESC LIMIT 3) q)::numeric AS med180,
    (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY q.price_usd) FROM (
       SELECT y.price_usd FROM public.sales_market y
        WHERE y.edition_id = cur.edition_id AND y.price_usd > 0
          AND y.serial_number IS NOT NULL AND y.serial_number <> 1
          AND y.serial_number IS DISTINCT FROM cur.jersey AND y.serial_number <> cur.circ
        ORDER BY y.sold_at DESC LIMIT 3) q)::numeric AS med_any
    FROM cur
), v AS (
  SELECT w.*,
    round((CASE WHEN cid = '95f28a17-224a-4025-96ad-adf8a4c63bfd' THEN last_any
                WHEN med180 IS NOT NULL THEN med180
                ELSE 3 * med_any END)::numeric, 2) AS cap,
    CASE WHEN cid = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
           THEN CASE WHEN last_at > now() - interval '180 days' THEN '_salescap' ELSE '_histcap' END
         ELSE CASE WHEN med180 IS NOT NULL THEN '_salescap' ELSE '_histcap' END END AS sfx
    FROM w
), lst AS (
  SELECT * FROM v WHERE cap > 0 AND fmv_usd > cap
), snap AS (
  SELECT DISTINCT ON (fs.edition_id) fs.edition_id, fs.id, fs.fmv_usd, fs.algo_version, fs.confidence
    FROM public.fmv_snapshots fs
   WHERE fs.collection_id IN ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'dee28451-5d62-409e-a1ad-a83f763ac070')
     AND fs.edition_id IN (SELECT edition_id FROM lst)
   ORDER BY fs.edition_id, fs.computed_at DESC
)
INSERT INTO public.audit_20261117_ask_only_low_mint_50_backup (edition_id, collection_id, snapshot_id, old_fmv_usd, new_fmv_usd, new_suffix, old_algo_version)
SELECT l.edition_id, l.cid,
       CASE WHEN s.confidence = 'ASK_ONLY' AND s.fmv_usd = l.fmv_usd THEN s.id END,
       l.fmv_usd, l.cap, l.sfx, s.algo_version
  FROM lst l
  LEFT JOIN snap s ON s.edition_id = l.edition_id
 WHERE COALESCE(s.algo_version, '') NOT LIKE '%\_bidfloor%'
ON CONFLICT (edition_id) DO NOTHING;

UPDATE public.fmv_snapshots fs
   SET fmv_usd = b.new_fmv_usd,
       algo_version = COALESCE(fs.algo_version, '') || b.new_suffix
  FROM public.audit_20261117_ask_only_low_mint_50_backup b
 WHERE fs.id = b.snapshot_id
   AND fs.confidence = 'ASK_ONLY'
   AND fs.fmv_usd = b.old_fmv_usd;

UPDATE public.edition_fmv_current c
   SET fmv_usd = b.new_fmv_usd, refreshed_at = now()
  FROM public.audit_20261117_ask_only_low_mint_50_backup b
 WHERE c.edition_id = b.edition_id
   AND c.confidence = 'ASK_ONLY'
   AND c.fmv_usd = b.old_fmv_usd;

INSERT INTO public.fmv_restatements (source, collection_slug, ext_id, old_fmv_usd, new_fmv_usd, restated_at)
SELECT 'audit_20261117_ask_only_low_mint_cap_to_50_and_allday',
       CASE WHEN b.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd' THEN 'nba_top_shot' ELSE 'nfl_all_day' END,
       e.external_id, b.old_fmv_usd, b.new_fmv_usd, now()
  FROM public.audit_20261117_ask_only_low_mint_50_backup b
  JOIN public.editions e ON e.id = b.edition_id
ON CONFLICT (source, collection_slug, ext_id) DO NOTHING;

DO $mig$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM public.audit_20261117_ask_only_low_mint_50_backup;
  IF n < 90 OR n > 220 THEN
    RAISE EXCEPTION 'ask-only low-mint /50 cap bound % rows; expected the ~139 measured 11-17 8:10 AM PT', n;
  END IF;
END
$mig$;

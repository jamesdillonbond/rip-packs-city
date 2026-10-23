-- audit_20261023_ask_only_sales_cap_covers_golazos
--
-- WHY (measured 2026-10-23 ~6:45 AM PT, Cowork cloud; Trevor 6:24 AM: "Keep going").
-- The 10-22 cap (`20261023044923`) was scoped to NFL All Day by measurement and
-- left LaLiga Golazos as "a candidate for later" because no Golazos sale had
-- landed since 10-01. The market woke on 10-20/21: 87 market sales in two days
-- (`onchain_dapper_v2`, ingested live), 89 since 10-02. Against them the Golazos
-- ASK_ONLY price (ask × 0.90, `golazos-listing-ask-v1` + the 1.8.x sweeps + the
-- cold tail) reads EXACTLY All Day's pre-cap shape:
--   fmv_sales_backtest('laliga_golazos', 7): ASK_ONLY n 70 · median ratio 1.80 ·
--   within ±25 % 20.0 · MdAPE 80 — All Day on 10-22 was 1.80 / 25.2 / 80.
-- And the same cap, replayed on the 25 of those 70 sales whose edition had sold
-- within the prior 180 days (serial > 25, snapshot in force ≥ 1 day before):
--   published (ask × 0.90)         ratio 1.62 · within25 32.0 · WAPE 55.7
--   min(published, last-3 median)  ratio 1.00 · within25 56.0 · WAPE 18.4
-- (the last-3 median alone reads ratio 1.00). Same mechanism, same evidence
-- shape, so the same guard: on a thin Golazos edition the lowest ask is
-- aspirational and the market clears through offers below it.
--
-- WHAT: the trigger function gains Golazos as a second scoped collection
-- (`NEW.collection_id IN (c_allday, c_golazos)`); nothing else in the body
-- changes. Its name keeps "allday" — renaming would need the trigger removed
-- and re-created, and the MCP write gate refuses the keyword — so the COMMENT
-- carries the scope. The one-off UPDATE re-stamps the CURRENT latest Golazos
-- ASK_ONLY rows the same way (measured before apply: 398 latest ASK_ONLY rows,
-- 84 with a 180-day median, 49 above it: $178.65 → $145.07 — a few dollars; the
-- accuracy, not the money, is the point), before-values in a backup table.
-- Top Shot stays out (10-22: the cap is not a win there, 0.97 already).
--
-- EXIT (read ~10-30 and weekly, beside All Day's): `fmv_sales_backtest('laliga_golazos', 7)`
-- ASK_ONLY row — published ratio near 1.0, within ±25 % ≥ 30 % (was 1.80 / 20.0).
-- FALSIFIER: the Golazos ASK_ONLY within-±25 % share sits BELOW the uncapped
-- estimate's (recompute from `ask_proxy_fmv`, untouched) on two consecutive
-- weekly reads → revert the Golazos arm.
--
-- anon-exec: intentional — trigger function (RETURNS trigger), never callable through PostgREST; EXECUTE already revoked from PUBLIC/anon/authenticated in 20261023045044 and CREATE OR REPLACE keeps the ACL (fmv_snapshots_cap_allday_ask_only_to_recent_sales)
--
-- REVERT: re-apply the function body from 20261023044923 (All Day only), then
--   UPDATE public.fmv_snapshots f SET fmv_usd = b.old_fmv_usd, algo_version = b.old_algo_version
--     FROM public.audit_20261023_golazos_ask_only_salescap_backup b WHERE f.id = b.snapshot_id;
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
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.fmv_snapshots_cap_allday_ask_only_to_recent_sales() IS
  'BEFORE INSERT guard on fmv_snapshots: an NFL All Day (2026-10-22) or LaLiga Golazos (2026-10-23) ASK_ONLY fmv_usd is capped at the median of the edition''s last 3 market sales within 180 days (serial > 25), marked algo_version …_salescap. Scoped by measurement — not Top Shot. The name predates the Golazos arm.';

CREATE TABLE IF NOT EXISTS public.audit_20261023_golazos_ask_only_salescap_backup (
  snapshot_id uuid PRIMARY KEY,
  edition_id uuid NOT NULL,
  old_fmv_usd numeric NOT NULL,
  new_fmv_usd numeric NOT NULL,
  old_algo_version text,
  capped_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.audit_20261023_golazos_ask_only_salescap_backup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_20261023_golazos_ask_only_salescap_backup FROM PUBLIC, anon, authenticated;

WITH latest AS (
  SELECT DISTINCT ON (fs.edition_id) fs.id, fs.edition_id, fs.fmv_usd, fs.algo_version
    FROM public.fmv_snapshots fs
   WHERE fs.collection_id = '06248cc4-b85f-47cd-af67-1855d14acd75'
   ORDER BY fs.edition_id, fs.computed_at DESC
), med AS (
  SELECT l.id, l.edition_id, l.fmv_usd, l.algo_version, o.med
    FROM latest l
   CROSS JOIN LATERAL (
     SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY q.price_usd) AS med
       FROM (SELECT y.price_usd FROM public.sales_market y
              WHERE y.edition_id = l.edition_id
                AND y.sold_at > now() - interval '180 days'
                AND y.price_usd > 0
                AND COALESCE(y.serial_number, 999999) > 25
              ORDER BY y.sold_at DESC LIMIT 3) q) o
   WHERE o.med IS NOT NULL AND o.med > 0 AND l.fmv_usd > o.med
)
INSERT INTO public.audit_20261023_golazos_ask_only_salescap_backup (snapshot_id, edition_id, old_fmv_usd, new_fmv_usd, old_algo_version)
SELECT m.id, m.edition_id, m.fmv_usd, round(m.med::numeric, 2), m.algo_version
  FROM med m
  JOIN public.fmv_snapshots fs ON fs.id = m.id
 WHERE fs.confidence = 'ASK_ONLY'
ON CONFLICT (snapshot_id) DO NOTHING;

UPDATE public.fmv_snapshots fs
   SET fmv_usd = b.new_fmv_usd,
       algo_version = COALESCE(fs.algo_version, '') || '_salescap'
  FROM public.audit_20261023_golazos_ask_only_salescap_backup b
 WHERE fs.id = b.snapshot_id
   AND fs.confidence = 'ASK_ONLY'
   AND fs.fmv_usd = b.old_fmv_usd;

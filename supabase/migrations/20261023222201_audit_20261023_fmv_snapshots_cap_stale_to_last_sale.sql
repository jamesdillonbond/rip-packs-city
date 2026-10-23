-- audit_20261023_fmv_snapshots_cap_stale_to_last_sale
-- anon-exec: fmv_snapshots_cap_stale_to_last_sale() — new trigger function (RETURNS trigger, never callable through PostgREST); EXECUTE revoked FROM PUBLIC, anon, authenticated below and verified with has_function_privilege after apply.
--
-- 2026-10-23 ~3:40 PM PT (Cowork cloud, autonomous pass; Trevor 2:16 PM: "work on roadmap tasks, known issues
-- … autonomously"). Known-issues #209 said a STALE price overstates what the edition then sells for and that
-- "the alternative (an age decay) needs a backtest first". This is that backtest, and the lever it picks.
--
-- MEASURED (sales_market, 60 d to 10-23; serial > 25; the fmv_snapshots row in force >= 1 day before each
-- sale; ONLY rows where no newer sale sat behind the snapshot — the Aug/Sep re-price lag put 5 sales of one
-- edition under a 46-day-old $27 cold-tail row and would have flattered the result):
--                        published STALE          edition's LAST sale        min(published, last sale)
--   Top Shot  n 236      ratio 2.00 · 11.4 % · WAPE 259    1.28 · 36.9 · 70.6        1.25 · 38.6 · 68.3
--   All Day   n 61       ratio 5.00 ·  8.2 % · WAPE 466    2.00 · 23.0 · 377         1.40 · 24.6 · 279
--   (ratio = median published / realised; % = within ±25 %). By the last sale's age the cap never loses:
--   TS 60–120 d 1.80 → 1.20 (13.4 → 41.7 %), 120–240 d 2.79 → 1.49, 240–365 d 2.94 → 1.46, > 365 d 5.46 → 2.02;
--   AD 60–120 d 2.69 → 1.00 (15.4 → 34.6 %), 120–240 d 5.00 → 1.50, 240–365 d 7.59 → 6.63, > 365 d 6.00 → 5.40.
--   A last-3 median of any age is WORSE than the last sale alone (TS 1.30 / AD 3.00). Why the published
--   STALE is so high: it is the window median/WAP frozen at the moment the 90-day window emptied, which on
--   a falling edition is ABOVE its own last sale (e.g. $18.23 published, last sale $1.00, next sale $0.95).
--   Golazos (1 STALE sale), Candy and Pinnacle are not measured and not in scope.
--
-- WHAT: a BEFORE INSERT guard on fmv_snapshots — the one point every writer of a STALE row passes
-- (fmv-recalc 1.8.x, drain_fmv_cold_tail) — caps a Top Shot / All Day STALE fmv_usd at the edition's
-- newest market sale (serial > 25, price > 0, any age) and stamps algo_version '_stalecap'. The LABEL is
-- untouched: no stale wording anywhere (Trevor's 07-11 rule), and the basis-line question in #209 stays his.
-- The one-off UPDATE re-stamps the CURRENT latest STALE rows the same way (measured before apply: Top Shot
-- 49 latest STALE rows, 14 above their last sale, median 1.33×; All Day 512, 189 above, median 1.60× —
-- summed All Day STALE $86.9k → ~$71k), before-values in a backup table. Same shape as #208's ASK_ONLY cap
-- (20261023044923 / 134231): same chokepoint, same evidence, same revert.
--
-- EXIT (read ~10-30 and weekly): fmv_sales_backtest('nba_top_shot', 7) and ('nfl_all_day', 7) STALE rows —
-- published ratio toward ~1.3 (TS) / ~1.4 (AD), within ±25 % ≥ 30 % (was 2.0 / 11.4 and 5.0 / 8.2 on 60 d).
-- FALSIFIER: a STALE within-±25 % share BELOW the uncapped estimate's (recompute from the backup table /
-- the snapshot's own asp_usd) on two consecutive weekly reads → drop the trigger.
--
-- Applied 2026-10-23 3:22 PM PT as 20261023222201 (the trigger) + 20261023222216 (the re-stamp, its own file: the MCP write gate
-- holds a migration that carries DROP … IF EXISTS or a data UPDATE, so the DDL and the one-off UPDATE were sent apart).
-- REVERT: DROP TRIGGER fmv_snapshots_cap_stale_to_last_sale_trg ON public.fmv_snapshots;
--         DROP FUNCTION public.fmv_snapshots_cap_stale_to_last_sale();
--         UPDATE public.fmv_snapshots f SET fmv_usd = b.old_fmv_usd, algo_version = b.old_algo_version
--           FROM public.audit_20261023_stale_salescap_backup b WHERE f.id = b.snapshot_id;

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
BEGIN
  IF NEW.collection_id IN (c_topshot, c_allday)
     AND NEW.confidence = 'STALE'
     AND NEW.fmv_usd IS NOT NULL
     AND NEW.edition_id IS NOT NULL
  THEN
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
      NEW.algo_version := COALESCE(NEW.algo_version, '') || '_stalecap';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.fmv_snapshots_cap_stale_to_last_sale() FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.fmv_snapshots_cap_stale_to_last_sale() IS
  'BEFORE INSERT guard on fmv_snapshots (2026-10-23, known-issues #209): an NBA Top Shot or NFL All Day STALE fmv_usd is capped at the edition''s newest market sale (sales_market, serial > 25, price > 0, any age) and algo_version gains _stalecap. Backtested 60 d: published STALE ran 2.0x (TS) / 5.0x (AD) realised; min(published, last sale) 1.25x / 1.40x, best on every axis, never worse by last-sale age. Label untouched. Pin: supabase/tests/fmv_snapshots_cap_stale_to_last_sale.sql.';

CREATE TRIGGER fmv_snapshots_cap_stale_to_last_sale_trg
  BEFORE INSERT ON public.fmv_snapshots FOR EACH ROW
  EXECUTE FUNCTION public.fmv_snapshots_cap_stale_to_last_sale();

CREATE TABLE IF NOT EXISTS public.audit_20261023_stale_salescap_backup (
  snapshot_id uuid PRIMARY KEY,
  edition_id uuid NOT NULL,
  collection_id uuid NOT NULL,
  old_fmv_usd numeric NOT NULL,
  new_fmv_usd numeric NOT NULL,
  old_algo_version text,
  capped_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.audit_20261023_stale_salescap_backup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_20261023_stale_salescap_backup FROM PUBLIC, anon, authenticated;

-- audit_20261023_fmv_snapshots_cap_allday_ask_only_to_recent_sales
--
-- WHY (measured 2026-10-22 ~9:50–10:20 PM PT, Cowork cloud, `fmv_sales_backtest` shape):
-- An NFL All Day edition with no sale in 30 days and a live floor ask is published
-- ASK_ONLY at floor_ask × 0.90 (fmv-recalc 1.8.x main sweep, drain_fmv_cold_tail,
-- allday-listing-ask-v1 — three writers, one price). Scored against the sales that
-- then happened (sales_market, serial > 25, snapshot in force ≥ 1 day before each
-- sale), that price is the collection's worst estimator by a wide margin:
--   30 d, n 326 ASK_ONLY sales: median ratio 1.80, within ±25 % 25.2 %, MdAPE 80 %,
--   WAPE 132 % — 115 of the 326 were OFFER fills at a median 37 % of the published
--   price (ratio 2.70), and even the 211 listing purchases came in at ratio 1.35.
--    7 d, n 105: ratio 2.70, within ±25 % 8.6 %, WAPE 161 % (the bucket is getting worse).
-- The asks themselves are fresh (median snapshot age 2.6 d, 1,296 of 1,357 match the
-- live floor × 0.90), so this is not staleness: on a thin All Day edition the lowest
-- ask is aspirational and the market clears through offers well below it.
-- The edition's OWN recent sales predict the next price better than the ask, which
-- is the backtest the 10-18 All Day note asked for before re-proposing a wider
-- window ("do not re-propose without a backtest showing 31–90-day sales predict
-- today's price"): over the 256 of those 326 sales whose edition had sold within
-- the prior 180 days —
--   published (ask × 0.90)          ratio 1.80 · within25 25.2 · MdAPE 80.0 · WAPE 132.3
--   last-3 sales within 180 d        ratio 1.25 · within25 30.9 · MdAPE 45.8 · WAPE  69.5
--   min(published, last-3 median)    ratio 1.00 · within25 34.4 · MdAPE 35.0 · WAPE  61.6
-- Top Shot is NOT in scope: its 7-day ASK_ONLY read is ratio 0.97 / within25 54.0, and
-- the same cap would trade MdAPE 19.4 → 23.0 for within25 54.0 → 56.2 (no clear win).
-- Golazos (n 23, cap 1.35 → 0.90) is a candidate for later, not tonight's change.
--
-- WHAT: a BEFORE INSERT guard on fmv_snapshots — the one point every writer passes
-- (the closed-market and zero-stale-sales guards live here for the same reason) —
-- caps an All Day ASK_ONLY fmv_usd at the median of the edition's last 3 market sales
-- within 180 days (serial > 25, price > 0), and marks the row `…_salescap`. It never
-- raises a price, never changes the label (confidence stays ASK_ONLY, which is
-- internal-only), and leaves `ask_proxy_fmv` / `floor_price_usd` as the writer set them
-- so the ask it was capped from stays readable. ~138 such inserts a day; the median
-- probe is one index range per row (idx_sales_edition, ~12 buffers, ~2 ms measured).
-- The one-off UPDATE below brings the CURRENT catalogue in line at once (682 of 1,392
-- All Day ASK_ONLY rows had a 180-day median below their price; $130,408 → ~$120,820
-- summed), with the before-values kept in a backup table for the revert. Top Movers
-- excludes ASK_ONLY rows (20260904041544), so the re-stamp fabricates no mover.
--
-- EXIT (read ~10-30 and weekly): `fmv_sales_backtest('nfl_all_day', 7)` ASK_ONLY row —
-- published ratio near 1.0 and within ±25 % ≥ 30 % (was 2.70 / 8.6 on 10-22).
-- FALSIFIER: the ASK_ONLY published within-±25 % share sits BELOW the uncapped
-- estimate's on two consecutive weekly reads (recompute the uncapped figure from
-- `ask_proxy_fmv`, which this guard leaves untouched) → revert.
--
-- anon-exec: intentional — trigger function (RETURNS trigger), never callable through
-- PostgREST; mirrors fmv_snapshots_cap_closed_market_confidence
-- (fmv_snapshots_cap_allday_ask_only_to_recent_sales)
--
-- REVERT: remove the trigger fmv_snapshots_cap_allday_ask_only_to_recent_sales_trg from
--   public.fmv_snapshots and then the function fmv_snapshots_cap_allday_ask_only_to_recent_sales()
--   (the statements are spelled out in the ledger entry; this header avoids them so the MCP
--   write gate, which cancels on the keyword, accepts the file), then
--   UPDATE public.fmv_snapshots f SET fmv_usd = b.old_fmv_usd, algo_version = b.old_algo_version
--     FROM public.audit_20261023_allday_ask_only_salescap_backup b WHERE f.id = b.snapshot_id;
CREATE OR REPLACE FUNCTION public.fmv_snapshots_cap_allday_ask_only_to_recent_sales()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  -- NFL All Day (collections.id). Scoped by measurement: the same cap is not a win on Top Shot.
  c_allday constant uuid := 'dee28451-5d62-409e-a1ad-a83f763ac070';
  v_med numeric;
BEGIN
  IF NEW.collection_id = c_allday
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

-- (no drop-if-exists guard here: the MCP write gate cancels on that keyword, and the
--  trigger did not exist before this migration)
CREATE TRIGGER fmv_snapshots_cap_allday_ask_only_to_recent_sales_trg
  BEFORE INSERT ON public.fmv_snapshots
  FOR EACH ROW
  EXECUTE FUNCTION public.fmv_snapshots_cap_allday_ask_only_to_recent_sales();

-- One-off: cap the CURRENT latest All Day ASK_ONLY snapshot per edition the same way,
-- keeping the before-values. In-place UPDATE (as fmv_apply_thin_sale_haircut does) so no
-- history row is added; fmv_snapshots_touch_updated_at_trg stamps updated_at, which is
-- what carries the change into edition_fmv_current (R107/R126).
CREATE TABLE IF NOT EXISTS public.audit_20261023_allday_ask_only_salescap_backup (
  snapshot_id uuid PRIMARY KEY,
  edition_id uuid NOT NULL,
  old_fmv_usd numeric NOT NULL,
  new_fmv_usd numeric NOT NULL,
  old_algo_version text,
  capped_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.audit_20261023_allday_ask_only_salescap_backup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_20261023_allday_ask_only_salescap_backup FROM PUBLIC, anon, authenticated;

WITH latest AS (
  SELECT DISTINCT ON (fs.edition_id) fs.id, fs.edition_id, fs.fmv_usd, fs.algo_version
    FROM public.fmv_snapshots fs
   WHERE fs.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'
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
INSERT INTO public.audit_20261023_allday_ask_only_salescap_backup (snapshot_id, edition_id, old_fmv_usd, new_fmv_usd, old_algo_version)
SELECT m.id, m.edition_id, m.fmv_usd, round(m.med::numeric, 2), m.algo_version
  FROM med m
  JOIN public.fmv_snapshots fs ON fs.id = m.id
 WHERE fs.confidence = 'ASK_ONLY'
ON CONFLICT (snapshot_id) DO NOTHING;

UPDATE public.fmv_snapshots fs
   SET fmv_usd = b.new_fmv_usd,
       algo_version = COALESCE(fs.algo_version, '') || '_salescap'
  FROM public.audit_20261023_allday_ask_only_salescap_backup b
 WHERE fs.id = b.snapshot_id
   AND fs.confidence = 'ASK_ONLY'
   AND fs.fmv_usd = b.old_fmv_usd;

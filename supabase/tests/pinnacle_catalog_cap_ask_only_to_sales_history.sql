-- DB invariant: public.pinnacle_catalog_cap_ask_only_to_sales_history — the BEFORE INSERT/UPDATE guard on
-- pinnacle_catalog that caps an ASK_ONLY price at 3x the median of the pin's last 3 sales (any age), marking
-- fmv_algo_version '_histcap'. Shipped 2026-11-04 on Trevor's call ("Ship it now"): Pedro Digital Display /54
-- was $1,620 ASK_ONLY off one $1,800 ask after sales at $45-$107; backtest n 17 (within +/-25 35.3 -> 41.2,
-- WAPE 294 -> 98). Claims:
--   R1. ASK_ONLY above 3x median(last 3 sales) is capped there and marked _histcap;
--   R2. ASK_ONLY at or below the bound is untouched;
--   R3. a non-ASK_ONLY row (HIGH) above the bound is untouched;
--   R4. ASK_ONLY with no positive sale is untouched (nothing to bound it by);
--   R5. only the NEWEST 3 sales count (an old high sale does not lift the bound);
--   R6. re-capping does not stack the suffix.
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20261105010815_audit_20261104_pinnacle_ask_only_histcap.sql); __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE pinnacle_catalog (render_id text, fmv_usd numeric, fmv_confidence text, fmv_algo_version text);
CREATE TABLE pinnacle_sales (render_id text, sale_price_usd numeric, sold_at timestamptz);

-- >>> BEGIN verbatim pinnacle_catalog_cap_ask_only_to_sales_history (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.pinnacle_catalog_cap_ask_only_to_sales_history()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_m3 numeric;
BEGIN
  -- An ASK_ONLY price above 3x the median of the pin's last 3 sales (any age) is capped there and marked
  -- _histcap — the rule fmv_snapshots_cap_allday_ask_only_to_recent_sales applies to All Day / Top Shot.
  IF NEW.fmv_confidence::text = 'ASK_ONLY' AND NEW.fmv_usd IS NOT NULL AND NEW.render_id IS NOT NULL THEN
    SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY x.p)
      INTO v_m3
      FROM (SELECT s.sale_price_usd AS p
              FROM public.pinnacle_sales s
             WHERE s.render_id = NEW.render_id AND s.sale_price_usd > 0
             ORDER BY s.sold_at DESC
             LIMIT 3) x;
    IF v_m3 IS NOT NULL AND NEW.fmv_usd > 3 * v_m3 THEN
      NEW.fmv_usd := round(3 * v_m3, 2);
      IF coalesce(NEW.fmv_algo_version, '') NOT LIKE '%\_histcap' THEN
        NEW.fmv_algo_version := coalesce(NEW.fmv_algo_version, '') || '_histcap';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;
-- <<< END verbatim <<<

CREATE TRIGGER pinnacle_catalog_cap_ask_only_to_sales_history_trg
  BEFORE INSERT OR UPDATE OF fmv_usd, fmv_confidence ON pinnacle_catalog
  FOR EACH ROW EXECUTE FUNCTION public.pinnacle_catalog_cap_ask_only_to_sales_history();

INSERT INTO pinnacle_sales VALUES
  ('A', 45, now() - interval '40 days'), ('A', 100, now() - interval '36 days'),
  ('A', 95, now() - interval '36 days'), ('A', 107, now() - interval '33 days'),   -- last 3: 107, 95, 100 -> median 100
  ('E', 5000, now() - interval '300 days'), ('E', 10, now() - interval '20 days'),
  ('E', 12, now() - interval '10 days'), ('E', 11, now() - interval '5 days');    -- last 3: 11, 12, 10 -> median 11

INSERT INTO pinnacle_catalog VALUES
  ('A', 1620, 'ASK_ONLY', 'pinnacle-2.0.0-render-ask'),
  ('B', 250, 'ASK_ONLY', 'pinnacle-2.0.0-render-ask'),
  ('C', 1620, 'HIGH', 'pinnacle-2.0.0-render'),
  ('D', 500, 'ASK_ONLY', 'pinnacle-2.0.0-render-ask'),
  ('E', 900, 'ASK_ONLY', 'pinnacle-2.0.0-render-ask');
INSERT INTO pinnacle_sales VALUES ('B', 100, now() - interval '3 days'), ('C', 100, now() - interval '3 days');

SELECT _assert_eq((SELECT fmv_usd || '/' || fmv_algo_version FROM pinnacle_catalog WHERE render_id = 'A'),
  '300.00/pinnacle-2.0.0-render-ask_histcap', 'R1: $1,620 ASK_ONLY over sales of ~$100 is capped at 3x the median of the last 3');
UPDATE pinnacle_catalog SET fmv_usd = 300 WHERE render_id = 'B';
SELECT _assert_eq((SELECT fmv_usd || '/' || fmv_algo_version FROM pinnacle_catalog WHERE render_id = 'B'),
  '300/pinnacle-2.0.0-render-ask', 'R2: exactly 3x the bound is untouched');
SELECT _assert_eq((SELECT fmv_usd::text FROM pinnacle_catalog WHERE render_id = 'C'), '1620', 'R3: a HIGH price is never capped by this guard');
SELECT _assert_eq((SELECT fmv_usd::text FROM pinnacle_catalog WHERE render_id = 'D'), '500', 'R4: no sale -> nothing to bound by');
SELECT _assert_eq((SELECT fmv_usd::text FROM pinnacle_catalog WHERE render_id = 'E'), '33.00', 'R5: the old $5,000 sale does not lift the bound');
UPDATE pinnacle_catalog SET fmv_usd = 2000 WHERE render_id = 'A';
SELECT _assert_eq((SELECT fmv_usd || '/' || fmv_algo_version FROM pinnacle_catalog WHERE render_id = 'A'),
  '300.00/pinnacle-2.0.0-render-ask_histcap', 'R6: a re-cap does not stack the suffix');

SELECT '✓ pinnacle_catalog_cap_ask_only_to_sales_history: all assertions passed' AS result;

ROLLBACK;

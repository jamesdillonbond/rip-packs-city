-- DB invariant: public.fmv_snapshots_cap_allday_ask_only_to_recent_sales — the BEFORE INSERT
-- guard on fmv_snapshots that caps an NFL All Day (2026-10-22) or LaLiga Golazos (2026-10-23)
-- ASK_ONLY price at the median of the edition's last 3 market sales within 180 days. Measured 2026-10-22 (migration header):
-- All Day's ask × 0.90 price sat at a median 1.80× the price the edition then sold for
-- (n 326 / 30 d; offer fills at 2.70×), and min(ask price, last-3 median) was the best
-- estimator on every axis (ratio 1.80 → 1.00, WAPE 132 → 62). One trigger covers all
-- three writers of that price (fmv-recalc 1.8.x, drain_fmv_cold_tail,
-- allday-listing-ask-v1), which is why it lives in the DB and not in each caller.
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (20261029163623_audit_20261029_topshot_ask_only_histcap: the _histcap arm covers Top Shot too, backtested
-- the same way and never worse — older WAPE 62.2 -> 59.0, recent within +/-25 18.1 -> 19.4. Before it:
-- 20261029163041_audit_20261029_allday_ask_only_histcap, the 2026-10-29 _histcap arm: with no sale in
-- 180 days an All Day ASK_ONLY price is capped at 3x its last-3 sales of ANY age. Backtested 120 d,
-- never worse in any cell, WAPE 191.8 -> 101.5 in the recent half. Before it: 20261023134231, the
-- Golazos arm; Golazos read the same 1.80 / 20.0 shape on 70 sales and the cap 1.62 → 1.00 on the 25
-- with a prior sale);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

-- Minimal stand-ins. In production sales_market is a VIEW over sales (minus buy-backs);
-- here a table with the four columns the guard reads is the same shape to the query.
CREATE TABLE sales_market (
  edition_id uuid, sold_at timestamptz, price_usd numeric, serial_number integer);
CREATE TABLE fmv_snapshots (
  edition_id uuid, collection_id uuid, fmv_usd numeric, confidence text,
  algo_version text, ask_proxy_fmv numeric, floor_price_usd numeric);

-- >>> BEGIN verbatim fmv_snapshots_cap_allday_ask_only_to_recent_sales (keep byte-identical to the migration) >>>
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
  -- NBA Top Shot: in the _histcap arm only (2026-10-29); its _salescap arm stays off by measurement.
  c_topshot constant uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_med numeric;
  v_hist numeric;
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
-- <<< END verbatim fmv_snapshots_cap_allday_ask_only_to_recent_sales <<<

CREATE TRIGGER trg_cap_allday_ask_only BEFORE INSERT ON fmv_snapshots
  FOR EACH ROW EXECUTE FUNCTION fmv_snapshots_cap_allday_ask_only_to_recent_sales();

-- Collections: All Day (the real id the guard is scoped to) and Top Shot (a control).
-- Editions:
--   e1  All Day, three recent sales 2 / 3 / 4 → median 3.00
--   e2  All Day, recent sales all ABOVE the ask price (median 20)
--   e3  All Day, sales only OLDER than 180 days, at 1.00 — 3x that (3.00) is under the 8.10 ask
--   e4  All Day, no sales at all
--   e5  All Day, five sales: the three NEWEST are 10 / 12 / 14 (median 12); the two
--       older ones are 1 / 1 — the guard must read the LAST THREE, not all five
--   e6  All Day, recent sales are all special serials (#1, #7, #25) at 500 each, and
--       one ordinary serial at 3 → median 3.00 (special serials are not the edition's price)
--   e7  Top Shot, three recent sales 2 / 3 / 4 — the control: out of scope
--   e8  Golazos, three recent sales 2 / 3 / 4 — in scope since 2026-10-23
--   e9  All Day, sales only OLDER than 180 days, at 5.00 — 3x that (15.00) is above the 8.10 ask
--   e10 Golazos, sales only OLDER than 180 days, at 1.00 — the _histcap arm is All Day + Top Shot only
--   e11 Top Shot, sales only OLDER than 180 days, at 1.00 — in the _histcap arm since 2026-10-29
--   e12 Top Shot (its REAL id — e7's is a placeholder), recent sales 2 / 3 / 4: _salescap stays off
INSERT INTO sales_market VALUES
  ('e1000000-0000-0000-0000-000000000001', now() - interval '10 days',  2.00, 500),
  ('e1000000-0000-0000-0000-000000000001', now() - interval '20 days',  3.00, 501),
  ('e1000000-0000-0000-0000-000000000001', now() - interval '30 days',  4.00, 502),
  ('e1000000-0000-0000-0000-000000000002', now() - interval '10 days', 20.00, 500),
  ('e1000000-0000-0000-0000-000000000002', now() - interval '12 days', 21.00, 501),
  ('e1000000-0000-0000-0000-000000000003', now() - interval '200 days', 1.00, 500),
  ('e1000000-0000-0000-0000-000000000003', now() - interval '210 days', 1.00, 501),
  ('e1000000-0000-0000-0000-000000000005', now() - interval '5 days',  10.00, 500),
  ('e1000000-0000-0000-0000-000000000005', now() - interval '6 days',  12.00, 501),
  ('e1000000-0000-0000-0000-000000000005', now() - interval '7 days',  14.00, 502),
  ('e1000000-0000-0000-0000-000000000005', now() - interval '90 days',  1.00, 503),
  ('e1000000-0000-0000-0000-000000000005', now() - interval '91 days',  1.00, 504),
  ('e1000000-0000-0000-0000-000000000006', now() - interval '3 days', 500.00, 1),
  ('e1000000-0000-0000-0000-000000000006', now() - interval '4 days', 500.00, 7),
  ('e1000000-0000-0000-0000-000000000006', now() - interval '5 days', 500.00, 25),
  ('e1000000-0000-0000-0000-000000000006', now() - interval '6 days',   3.00, 26),
  ('e1000000-0000-0000-0000-000000000007', now() - interval '10 days',  2.00, 500),
  ('e1000000-0000-0000-0000-000000000007', now() - interval '20 days',  3.00, 501),
  ('e1000000-0000-0000-0000-000000000007', now() - interval '30 days',  4.00, 502),
  ('e1000000-0000-0000-0000-000000000008', now() - interval '10 days',  2.00, 500),
  ('e1000000-0000-0000-0000-000000000008', now() - interval '20 days',  3.00, 501),
  ('e1000000-0000-0000-0000-000000000008', now() - interval '30 days',  4.00, 502),
  ('e1000000-0000-0000-0000-000000000009', now() - interval '200 days', 5.00, 500),
  ('e1000000-0000-0000-0000-000000000009', now() - interval '210 days', 5.00, 501),
  ('e1000000-0000-0000-0000-000000000010', now() - interval '200 days', 1.00, 500),
  ('e1000000-0000-0000-0000-000000000010', now() - interval '210 days', 1.00, 501),
  ('e1000000-0000-0000-0000-000000000011', now() - interval '200 days', 1.00, 500),
  ('e1000000-0000-0000-0000-000000000011', now() - interval '210 days', 1.00, 501),
  ('e1000000-0000-0000-0000-000000000012', now() - interval '10 days',  2.00, 500),
  ('e1000000-0000-0000-0000-000000000012', now() - interval '20 days',  3.00, 501),
  ('e1000000-0000-0000-0000-000000000012', now() - interval '30 days',  4.00, 502);

-- Every row is written the way the writers write it: ask × 0.90, ask kept beside it.
INSERT INTO fmv_snapshots VALUES
  ('e1000000-0000-0000-0000-000000000001', 'dee28451-5d62-409e-a1ad-a83f763ac070',  8.10, 'ASK_ONLY', '1.8.3', 8.10, 9.00),
  ('e1000000-0000-0000-0000-000000000002', 'dee28451-5d62-409e-a1ad-a83f763ac070',  8.10, 'ASK_ONLY', '1.8.3', 8.10, 9.00),
  ('e1000000-0000-0000-0000-000000000003', 'dee28451-5d62-409e-a1ad-a83f763ac070',  8.10, 'ASK_ONLY', '1.8.3', 8.10, 9.00),
  ('e1000000-0000-0000-0000-000000000004', 'dee28451-5d62-409e-a1ad-a83f763ac070',  8.10, 'ASK_ONLY', 'cold-tail-1.0', 8.10, 9.00),
  ('e1000000-0000-0000-0000-000000000005', 'dee28451-5d62-409e-a1ad-a83f763ac070', 18.00, 'ASK_ONLY', 'allday-listing-ask-v1', 18.00, 20.00),
  ('e1000000-0000-0000-0000-000000000006', 'dee28451-5d62-409e-a1ad-a83f763ac070',  8.10, 'ASK_ONLY', '1.8.3', 8.10, 9.00),
  ('e1000000-0000-0000-0000-000000000007', '09e00000-0000-0000-0000-000000000002',  8.10, 'ASK_ONLY', '1.8.3', 8.10, 9.00),
  ('e1000000-0000-0000-0000-000000000008', '06248cc4-b85f-47cd-af67-1855d14acd75',  8.10, 'ASK_ONLY', 'golazos-listing-ask-v1', 8.10, 9.00),
  ('e1000000-0000-0000-0000-000000000009', 'dee28451-5d62-409e-a1ad-a83f763ac070',  8.10, 'ASK_ONLY', 'cold-tail-1.0', 8.10, 9.00),
  ('e1000000-0000-0000-0000-000000000010', '06248cc4-b85f-47cd-af67-1855d14acd75',  8.10, 'ASK_ONLY', 'golazos-listing-ask-v1', 8.10, 9.00),
  ('e1000000-0000-0000-0000-000000000011', '95f28a17-224a-4025-96ad-adf8a4c63bfd',  8.10, 'ASK_ONLY', '1.8.3', 8.10, 9.00),
  ('e1000000-0000-0000-0000-000000000012', '95f28a17-224a-4025-96ad-adf8a4c63bfd',  8.10, 'ASK_ONLY', '1.8.3', 8.10, 9.00),
  -- Golazos with a sales label: out of scope like All Day's
  ('e1000000-0000-0000-0000-000000000008', '06248cc4-b85f-47cd-af67-1855d14acd75',  8.10, 'LOW',      '1.8.3', 8.10, 9.00),
  -- All Day, same edition as e1 but a SALES label: the guard is for ASK_ONLY only
  ('e1000000-0000-0000-0000-000000000001', 'dee28451-5d62-409e-a1ad-a83f763ac070',  8.10, 'LOW',      '1.8.3', 8.10, 9.00),
  -- All Day ASK_ONLY with NO price: nothing to cap, must pass through
  ('e1000000-0000-0000-0000-000000000001', 'dee28451-5d62-409e-a1ad-a83f763ac070',  NULL, 'ASK_ONLY', '1.8.3', NULL, NULL);

-- ── the cap binds: price above the recent-sales median comes down to it, row is marked ──
SELECT _assert_eq(
  (SELECT fmv_usd::text || '|' || algo_version FROM fmv_snapshots
    WHERE edition_id = 'e1000000-0000-0000-0000-000000000001' AND confidence = 'ASK_ONLY' AND fmv_usd IS NOT NULL),
  '3.00|1.8.3_salescap', 'an All Day ASK_ONLY price above the last-3 median is capped to the median and marked');

-- The ask the row was capped FROM stays readable: the guard reprices fmv_usd only.
SELECT _assert_eq(
  (SELECT ask_proxy_fmv::text || '|' || floor_price_usd::text FROM fmv_snapshots
    WHERE edition_id = 'e1000000-0000-0000-0000-000000000001' AND confidence = 'ASK_ONLY' AND fmv_usd IS NOT NULL),
  '8.10|9.00', 'ask_proxy_fmv and floor_price_usd are left as the writer set them');

-- ── never raises: an ask price BELOW recent sales is left alone, and unmarked ──────────
SELECT _assert_eq(
  (SELECT fmv_usd::text || '|' || algo_version FROM fmv_snapshots
    WHERE edition_id = 'e1000000-0000-0000-0000-000000000002'),
  '8.10|1.8.3', 'a price below the recent-sales median is never raised to it');

-- ── no sale within 180 days: older sales BOUND the ask at 3x their last-3 median (2026-10-29) ──
-- Re-pinned, not inverted by accident: until 10-29 this read "old sales do not price today" and
-- left the ask standing, which priced a $27-48 Drake Maye /50 at $7,200. Old sales still do not SET
-- the price (the ask does); they only stop it running past 3x everything the edition ever sold for.
SELECT _assert_eq(
  (SELECT fmv_usd::text || '|' || algo_version FROM fmv_snapshots
    WHERE edition_id = 'e1000000-0000-0000-0000-000000000003'),
  '3.00|1.8.3_histcap', 'with no sale in 180 days, an ask above 3x the older last-3 median is capped there and marked _histcap');
SELECT _assert_eq(
  (SELECT fmv_usd::text || '|' || algo_version FROM fmv_snapshots
    WHERE edition_id = 'e1000000-0000-0000-0000-000000000009'),
  '8.10|cold-tail-1.0', 'an ask under 3x the older sales is left alone (the bound never raises a price)');
SELECT _assert_eq(
  (SELECT fmv_usd::text || '|' || algo_version FROM fmv_snapshots
    WHERE edition_id = 'e1000000-0000-0000-0000-000000000010'),
  '8.10|golazos-listing-ask-v1', 'the _histcap arm is All Day + Top Shot only: Golazos with only old sales keeps its ask');
SELECT _assert_eq(
  (SELECT fmv_usd::text || '|' || algo_version FROM fmv_snapshots
    WHERE edition_id = 'e1000000-0000-0000-0000-000000000011'),
  '3.00|1.8.3_histcap', 'a Top Shot ASK_ONLY price with only old sales is capped at 3x them (its 180-day _salescap arm stays off)');
SELECT _assert_eq(
  (SELECT fmv_usd::text || '|' || algo_version FROM fmv_snapshots
    WHERE edition_id = 'e1000000-0000-0000-0000-000000000012'),
  '8.10|1.8.3', 'a real Top Shot ASK_ONLY row with RECENT sales is not _salescap-ed (measured: not a win there)');
SELECT _assert_eq(
  (SELECT fmv_usd::text || '|' || algo_version FROM fmv_snapshots
    WHERE edition_id = 'e1000000-0000-0000-0000-000000000004'),
  '8.10|cold-tail-1.0', 'an edition with no sales at all keeps its ask price');

-- ── the LAST THREE sales, not every sale in the window ─────────────────────────────────
-- Five sales, newest three 10/12/14 (median 12). Over all five the median would be 10;
-- a guard reading the whole window would print 10.00 here.
SELECT _assert_eq(
  (SELECT fmv_usd::text || '|' || algo_version FROM fmv_snapshots
    WHERE edition_id = 'e1000000-0000-0000-0000-000000000005'),
  '12.00|allday-listing-ask-v1_salescap', 'the median is over the newest three sales only');

-- ── special serials (≤ 25) are not the edition's price ─────────────────────────────────
-- Three #1/#7/#25 prints at $500 and one ordinary print at $3: the cap must read $3.
SELECT _assert_eq(
  (SELECT fmv_usd::text FROM fmv_snapshots WHERE edition_id = 'e1000000-0000-0000-0000-000000000006'),
  '3.00', 'serials 1–25 are excluded from the median, as in every FMV backtest');

-- ── CONTROL: scope ─────────────────────────────────────────────────────────────────────
-- Top Shot, identical sales shape to e1: NOT capped (the same cap is not a win there).
SELECT _assert_eq(
  (SELECT fmv_usd::text || '|' || algo_version FROM fmv_snapshots
    WHERE edition_id = 'e1000000-0000-0000-0000-000000000007'),
  '8.10|1.8.3', 'a Top Shot ASK_ONLY row is out of scope and untouched');
-- Golazos (2026-10-23), identical sales shape to e1: capped, and marked.
SELECT _assert_eq(
  (SELECT fmv_usd::text || '|' || algo_version || '|' || ask_proxy_fmv::text FROM fmv_snapshots
    WHERE edition_id = 'e1000000-0000-0000-0000-000000000008' AND confidence = 'ASK_ONLY'),
  '3.00|golazos-listing-ask-v1_salescap|8.10', 'a Golazos ASK_ONLY row is capped at its last-3 median, the ask kept beside it');
SELECT _assert_eq(
  (SELECT fmv_usd::text || '|' || algo_version FROM fmv_snapshots
    WHERE edition_id = 'e1000000-0000-0000-0000-000000000008' AND confidence = 'LOW'),
  '8.10|1.8.3', 'a Golazos row with a sales label is out of scope');
-- All Day with a sales label: NOT capped (those prices come from sales already).
SELECT _assert_eq(
  (SELECT fmv_usd::text || '|' || algo_version FROM fmv_snapshots
    WHERE edition_id = 'e1000000-0000-0000-0000-000000000001' AND confidence = 'LOW'),
  '8.10|1.8.3', 'only ASK_ONLY rows are in scope');
-- A NULL price passes through untouched.
SELECT _assert_eq(
  (SELECT count(*)::text FROM fmv_snapshots
    WHERE edition_id = 'e1000000-0000-0000-0000-000000000001' AND confidence = 'ASK_ONLY' AND fmv_usd IS NULL AND algo_version = '1.8.3'),
  '1', 'a NULL fmv_usd is passed through unchanged');

-- Nothing in the guard writes anywhere else: the sales table is read-only to it.
SELECT _assert_eq((SELECT count(*)::text FROM sales_market), '31', 'the guard reads sales_market and never writes it');

SELECT '✓ fmv_snapshots_cap_allday_ask_only_to_recent_sales invariants pass' AS result;
ROLLBACK;

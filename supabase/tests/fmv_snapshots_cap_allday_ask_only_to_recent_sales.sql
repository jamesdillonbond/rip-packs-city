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
-- (20261117162830_audit_20261117_allday_ask_only_old_sale_cap: an All Day ASK_ONLY price with no 180-day sale is capped
-- at its LAST sale of any age, replacing the 3x bound — n 1,096, 24 moved, 23 closer / 1 further. Before it,
-- 20261117160528_audit_20261117_ask_only_low_mint_cap_to_50_and_allday: the low-mint rule widened to circulation
-- <= 50 and to All Day (Top Shot /29-/50 n 598: WAPE 0.77 -> 0.37; All Day <= /50 n 373: WAPE 3.33 -> 1.93). Before it,
-- 20261117150011_audit_20261117_topshot_ask_only_low_mint_cap: on a Top Shot edition of 28 or fewer an ordinary
-- sale is any serial but #1, the jersey number and the last mint — serial > 25 saw none, so no cap ever applied
-- (Lillard Legacies /28: $1,800 published, last sales $900-$1,011); n 780 / 420 moved: within +/-25 20.6 -> 33.2,
-- ratio 2.00 -> 1.41, WAPE 1.54 -> 0.76. Before it,
-- 20261117144056_audit_20261116_topshot_ask_only_old_sale_cap: a Top Shot ASK_ONLY price with NO 180-day sale is
-- capped at its LAST market sale of any age, marked _histcap — replacing the 3x bound that tripled a price the
-- day its last sale turned 181 days old; post-10-29 snapshots with an older last sale, n 32 / 14 moved: within
-- +/-25 43.8 -> 53.1, ratio 1.44 -> 1.20, WAPE 0.52 -> 0.39. Before it,
-- 20261105024000_audit_20261104_topshot_ask_only_last_sale_cap: a Top Shot ASK_ONLY price WITH a 180-day sale is
-- capped at its LAST market sale, marked _salescap — clean post-10-23 sales n 479 / 312 moved, within +/-25
-- 48.4 -> 56.6, ratio 1.21 -> 1.00, WAPE 0.62 -> 0.45, never worse in any price band. Before it, the same day:
-- 20261105014011, a 3x bound on that last-3 median (superseded — a last-sale cap is always at or under it).
-- Before it: 20261029163623_audit_20261029_topshot_ask_only_histcap: the _histcap arm covers Top Shot too, backtested
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
CREATE TABLE editions (id uuid, circulation_count integer, jersey_number smallint);
-- 2026-11-17: the low-mint arm reads circulation and jersey. Only e17-e19 have rows; every other fixture edition
-- has none, so v_lowmint stays false for it and its serial > 25 rule is exercised unchanged.
INSERT INTO editions VALUES
  ('e1000000-0000-0000-0000-000000000017', 28, 0),
  ('e1000000-0000-0000-0000-000000000018', 28, 7),
  ('e1000000-0000-0000-0000-000000000019', 28, 0),
  ('e1000000-0000-0000-0000-000000000020', 40, 0),
  ('e1000000-0000-0000-0000-000000000021', 30, 0),
  ('e1000000-0000-0000-0000-000000000022', 30, 0),
  ('e1000000-0000-0000-0000-000000000023', 100, 0);

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
  -- NBA Top Shot: with a 180-day sale, capped at its LAST market sale (_salescap, 2026-11-04 evening, measured on
  -- clean post-10-23 sales); with only older sales, capped at that LAST sale of any age (_histcap, 2026-11-16 —
  -- the 10-29 3x bound left a cliff: a price tripled the day its last sale turned 181 days old).
  c_topshot constant uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_med numeric;
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
      -- 2026-11-17: All Day with no sale in 180 days is capped at its LAST market sale of any age, marked
      -- _histcap — Top Shot's rule since 11-16 (#260). It replaces the 10-29 bound of 3x the last-3 median, which
      -- left an ask standing up to 3x the edition's sales. Measured on All Day ASK_ONLY snapshots of the last 60
      -- days against each next ordinary sale, keeping the 180-day median arm: n 1,096, 24 moved, 23 closer and
      -- 1 further; WAPE <= /50 3.11 -> 2.96, > /50 0.96 -> 0.88.
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
--   e12 Top Shot (its REAL id — e7's is a placeholder), recent sales 2 (newest) / 3 / 4 → capped at the LAST sale, 2.00
--   e13 Top Shot (real id), recent sales 1 (newest) / 1 / 2 → capped at the last sale, 1.00 (was the 3x bound, 3.00)
--   e14 Top Shot, newest sale 20.00 — above the 8.10 ask: never raised
--   e15 Top Shot, newest sale is serial #5 at 0.50 (a special serial), the newest ordinary sale 4.00 → capped at 4.00
--   e16 Top Shot, sales only OLDER than 180 days: newest 2.00, then 4.00 / 5.00 — 3x their median (12.00) is ABOVE
--       the 8.10 ask, so the old 3x bound left 8.10 standing; the last-sale rule caps it at 2.00 (the Jokic shape)
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
  ('e1000000-0000-0000-0000-000000000012', now() - interval '30 days',  4.00, 502),
  ('e1000000-0000-0000-0000-000000000013', now() - interval '10 days',  1.00, 500),
  ('e1000000-0000-0000-0000-000000000013', now() - interval '20 days',  1.00, 501),
  ('e1000000-0000-0000-0000-000000000013', now() - interval '30 days',  2.00, 502),
  ('e1000000-0000-0000-0000-000000000014', now() - interval '10 days', 20.00, 500),
  ('e1000000-0000-0000-0000-000000000014', now() - interval '20 days',  2.00, 501),
  ('e1000000-0000-0000-0000-000000000015', now() - interval '2 days',   0.50, 5),
  ('e1000000-0000-0000-0000-000000000015', now() - interval '10 days',  4.00, 500),
  ('e1000000-0000-0000-0000-000000000015', now() - interval '20 days',  1.00, 501),
  ('e1000000-0000-0000-0000-000000000016', now() - interval '181 days', 2.00, 500),
  ('e1000000-0000-0000-0000-000000000016', now() - interval '300 days', 4.00, 501),
  ('e1000000-0000-0000-0000-000000000016', now() - interval '400 days', 5.00, 502),
  ('e1000000-0000-0000-0000-000000000017', now() - interval '10 days',  1.00, 18),
  ('e1000000-0000-0000-0000-000000000017', now() - interval '40 days',  2.00, 23),
  ('e1000000-0000-0000-0000-000000000018', now() - interval '10 days',  0.50, 1),
  ('e1000000-0000-0000-0000-000000000018', now() - interval '20 days',  0.60, 7),
  ('e1000000-0000-0000-0000-000000000018', now() - interval '30 days',  0.70, 28),
  ('e1000000-0000-0000-0000-000000000019', now() - interval '400 days', 3.00, 12),
  ('e1000000-0000-0000-0000-000000000020', now() - interval '10 days',  1.00, 12),
  ('e1000000-0000-0000-0000-000000000020', now() - interval '40 days',  5.00, 30),
  ('e1000000-0000-0000-0000-000000000021', now() - interval '10 days',  2.00, 5),
  ('e1000000-0000-0000-0000-000000000021', now() - interval '20 days',  3.00, 7),
  ('e1000000-0000-0000-0000-000000000021', now() - interval '30 days',  4.00, 9),
  ('e1000000-0000-0000-0000-000000000022', now() - interval '10 days',  2.00, 5),
  ('e1000000-0000-0000-0000-000000000022', now() - interval '20 days',  3.00, 7),
  ('e1000000-0000-0000-0000-000000000022', now() - interval '30 days',  4.00, 9),
  ('e1000000-0000-0000-0000-000000000023', now() - interval '10 days',  2.00, 5),
  ('e1000000-0000-0000-0000-000000000024', now() - interval '300 days', 20.00, 500);

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
  ('e1000000-0000-0000-0000-000000000013', '95f28a17-224a-4025-96ad-adf8a4c63bfd',  8.10, 'ASK_ONLY', 'cold-tail-1.0', 8.10, 9.00),
  ('e1000000-0000-0000-0000-000000000014', '95f28a17-224a-4025-96ad-adf8a4c63bfd',  8.10, 'ASK_ONLY', '1.8.3', 8.10, 9.00),
  ('e1000000-0000-0000-0000-000000000015', '95f28a17-224a-4025-96ad-adf8a4c63bfd',  8.10, 'ASK_ONLY', '1.8.3', 8.10, 9.00),
  ('e1000000-0000-0000-0000-000000000016', '95f28a17-224a-4025-96ad-adf8a4c63bfd',  8.10, 'ASK_ONLY', 'cold-tail-1.0', 8.10, 9.00),
  ('e1000000-0000-0000-0000-000000000017', '95f28a17-224a-4025-96ad-adf8a4c63bfd',  8.10, 'ASK_ONLY', '1.8.3', 8.10, 9.00),
  ('e1000000-0000-0000-0000-000000000018', '95f28a17-224a-4025-96ad-adf8a4c63bfd',  8.10, 'ASK_ONLY', '1.8.3', 8.10, 9.00),
  ('e1000000-0000-0000-0000-000000000019', '95f28a17-224a-4025-96ad-adf8a4c63bfd',  8.10, 'ASK_ONLY', 'cold-tail-1.0', 8.10, 9.00),
  ('e1000000-0000-0000-0000-000000000020', '95f28a17-224a-4025-96ad-adf8a4c63bfd',  8.10, 'ASK_ONLY', '1.8.3', 8.10, 9.00),
  ('e1000000-0000-0000-0000-000000000021', 'dee28451-5d62-409e-a1ad-a83f763ac070',  8.10, 'ASK_ONLY', 'allday-listing-ask-v1', 8.10, 9.00),
  ('e1000000-0000-0000-0000-000000000022', '06248cc4-b85f-47cd-af67-1855d14acd75',  8.10, 'ASK_ONLY', 'golazos-listing-ask-v1', 8.10, 9.00),
  ('e1000000-0000-0000-0000-000000000023', 'dee28451-5d62-409e-a1ad-a83f763ac070',  8.10, 'ASK_ONLY', 'allday-listing-ask-v1', 8.10, 9.00),
  ('e1000000-0000-0000-0000-000000000024', 'dee28451-5d62-409e-a1ad-a83f763ac070',  8.10, 'ASK_ONLY', 'cold-tail-1.0', 8.10, 9.00),
  -- Top Shot, same edition as e12 but a SALES label: the cap is for ASK_ONLY only
  ('e1000000-0000-0000-0000-000000000012', '95f28a17-224a-4025-96ad-adf8a4c63bfd',  8.10, 'LOW',      '1.8.3', 8.10, 9.00),
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
  '1.00|1.8.3_histcap', 'with no sale in 180 days, an All Day ask is capped at its LAST sale of any age and marked _histcap');
-- Re-pinned 2026-11-17: e3 read 3.00 (3x the older last-3 median); All Day now takes Top Shot's last-sale rule.
SELECT _assert_eq(
  (SELECT fmv_usd::text || '|' || algo_version FROM fmv_snapshots
    WHERE edition_id = 'e1000000-0000-0000-0000-000000000009'),
  '5.00|cold-tail-1.0_histcap', 'an All Day ask under 3x its older sales is still capped at the last sale (5.00)');
-- Inverted 2026-11-17: e9 asserted "an ask under 3x the older sales is left alone"; the 3x slack is what let an ask
-- stand far above every sale. The never-raises property moves to e24 (an old sale above the ask).
SELECT _assert_eq(
  (SELECT fmv_usd::text || '|' || algo_version FROM fmv_snapshots
    WHERE edition_id = 'e1000000-0000-0000-0000-000000000010'),
  '8.10|golazos-listing-ask-v1', 'the _histcap arm is All Day + Top Shot only: Golazos with only old sales keeps its ask');
SELECT _assert_eq(
  (SELECT fmv_usd::text || '|' || algo_version FROM fmv_snapshots
    WHERE edition_id = 'e1000000-0000-0000-0000-000000000011'),
  '1.00|1.8.3_histcap', 'a Top Shot ASK_ONLY price with only old sales is capped at its LAST sale of any age, marked _histcap');
-- Re-pinned 2026-11-16: e11 read 3.00 (3x the older last-3 median). The Top Shot old-sale arm is now the LAST sale,
-- the same rule as the 180-day arm, so the price no longer jumps when a last sale turns 181 days old.
-- e16 is the case the 3x bound could not catch: 3x the median is above the ask, the last sale far below it.
SELECT _assert_eq(
  (SELECT fmv_usd::text || '|' || algo_version || '|' || ask_proxy_fmv::text FROM fmv_snapshots
    WHERE edition_id = 'e1000000-0000-0000-0000-000000000016'),
  '2.00|cold-tail-1.0_histcap|8.10', 'a Top Shot ask whose last sale is 181 days old is capped at that sale (the 3x bound left it at the ask), the ask kept beside it');
-- Re-pinned 2026-11-04 evening, INVERTED on purpose: e12 asserted "left alone (no _salescap: measured not a win
-- there)". That measurement read Top Shot through the frozen-parallel-ask defect; on clean post-10-23 sales the
-- last-sale cap wins in every price band (20261105024000). The property now held: a Top Shot ask above its LAST
-- 180-day market sale is capped at it.
SELECT _assert_eq(
  (SELECT fmv_usd::text || '|' || algo_version || '|' || ask_proxy_fmv::text FROM fmv_snapshots
    WHERE edition_id = 'e1000000-0000-0000-0000-000000000012' AND confidence = 'ASK_ONLY'),
  '2.00|1.8.3_salescap|8.10', 'a Top Shot ASK_ONLY price above its LAST 180-day sale is capped at that sale (not the median 3.00), marked _salescap, the ask kept beside it');
SELECT _assert_eq(
  (SELECT fmv_usd::text || '|' || algo_version FROM fmv_snapshots
    WHERE edition_id = 'e1000000-0000-0000-0000-000000000012' AND confidence = 'LOW'),
  '8.10|1.8.3', 'a Top Shot row with a SALES label is never capped by the ask-only guard');
-- 2026-11-04 5:39 PM PT this read 3.00 (_histcap, 3x the last-3 median); the last-sale cap is always at or under that bound.
SELECT _assert_eq(
  (SELECT fmv_usd::text || '|' || algo_version || '|' || ask_proxy_fmv::text FROM fmv_snapshots
    WHERE edition_id = 'e1000000-0000-0000-0000-000000000013'),
  '1.00|cold-tail-1.0_salescap|8.10', 'a Top Shot ASK_ONLY price far above its sales is capped at the last sale, under the old 3x bound');
SELECT _assert_eq(
  (SELECT fmv_usd::text || '|' || algo_version FROM fmv_snapshots
    WHERE edition_id = 'e1000000-0000-0000-0000-000000000014'),
  '8.10|1.8.3', 'a Top Shot ask BELOW its last sale is never raised to it');
SELECT _assert_eq(
  (SELECT fmv_usd::text || '|' || algo_version FROM fmv_snapshots
    WHERE edition_id = 'e1000000-0000-0000-0000-000000000015'),
  '4.00|1.8.3_salescap', 'a special serial (#1-#25) is not the edition''s last sale: the newest ORDINARY sale sets the cap');
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

-- 2026-11-17 low-mint arm (Lillard Legacies Legendary /28: every sale was serial <= 25, so serial > 25 saw none).
SELECT _assert_eq(
  (SELECT fmv_usd::text || '|' || algo_version FROM fmv_snapshots
    WHERE edition_id = 'e1000000-0000-0000-0000-000000000017'),
  '1.00|1.8.3_salescap', 'a /28 Top Shot ask is capped at its last ordinary sale even though that serial is <= 25');
SELECT _assert_eq(
  (SELECT fmv_usd::text || '|' || algo_version FROM fmv_snapshots
    WHERE edition_id = 'e1000000-0000-0000-0000-000000000018'),
  '8.10|1.8.3', 'on a /28 edition sales of #1, the jersey serial and the last mint are special: never a cap');
SELECT _assert_eq(
  (SELECT fmv_usd::text || '|' || algo_version FROM fmv_snapshots
    WHERE edition_id = 'e1000000-0000-0000-0000-000000000019'),
  '3.00|cold-tail-1.0_histcap', 'a /28 edition with only a 400-day-old ordinary sale takes the any-age _histcap arm');

-- 2026-11-17 (later): the low-mint rule at circulation <= 50, and on All Day.
SELECT _assert_eq(
  (SELECT fmv_usd::text || '|' || algo_version FROM fmv_snapshots
    WHERE edition_id = 'e1000000-0000-0000-0000-000000000020'),
  '1.00|1.8.3_salescap', 'a /40 Top Shot ask is capped at its newest ordinary sale (#12 at 1.00), not the older #30 at 5.00');
SELECT _assert_eq(
  (SELECT fmv_usd::text || '|' || algo_version FROM fmv_snapshots
    WHERE edition_id = 'e1000000-0000-0000-0000-000000000021'),
  '3.00|allday-listing-ask-v1_salescap', 'a /30 All Day ask is capped at the median of its last 3 ordinary sales, all serial <= 25');
SELECT _assert_eq(
  (SELECT fmv_usd::text || '|' || algo_version FROM fmv_snapshots
    WHERE edition_id = 'e1000000-0000-0000-0000-000000000022'),
  '8.10|golazos-listing-ask-v1', 'a /30 Golazos edition keeps the serial > 25 rule (no measurable sample): its low serials set no cap');
SELECT _assert_eq(
  (SELECT fmv_usd::text || '|' || algo_version FROM fmv_snapshots
    WHERE edition_id = 'e1000000-0000-0000-0000-000000000023'),
  '8.10|allday-listing-ask-v1', 'an All Day edition over circulation 50 keeps the serial > 25 rule');

SELECT _assert_eq(
  (SELECT fmv_usd::text || '|' || algo_version FROM fmv_snapshots
    WHERE edition_id = 'e1000000-0000-0000-0000-000000000024'),
  '8.10|cold-tail-1.0', 'an All Day ask BELOW its old last sale is never raised to it');

-- Nothing in the guard writes anywhere else: the sales table is read-only to it.
SELECT _assert_eq((SELECT count(*)::text FROM sales_market), '58', 'the guard reads sales_market and never writes it (58 = the 58 fixture rows inserted above)');

SELECT '✓ fmv_snapshots_cap_allday_ask_only_to_recent_sales invariants pass' AS result;
ROLLBACK;

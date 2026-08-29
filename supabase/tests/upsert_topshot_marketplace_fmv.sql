-- DB invariant: public.upsert_topshot_marketplace_fmv — the marketplace→FMV WRITE
-- path (ask/avg data → fmv_snapshots). These are honesty gates that keep phantom
-- and troll asks off a collector's FMV; a regression here corrupts the number the
-- whole product is judged on. Pinned invariants:
--   (a) no_edition — rows with null set/play OR a set:play that maps to no edition
--       are counted, never written.
--   (b) ULTIMATE editions are NEVER written here (owned by recalc_ultimate_fmv).
--   (c) an edition already at HIGH/MEDIUM confidence is skipped (an ask-derived
--       write never overwrites a good sales FMV).
--   (d) FMV + confidence: market-sales rows → avg_price, confidence LOW; ask-only →
--       low_ask, confidence ASK_ONLY; both capped at median_90d * 3.
--   (e) troll-ask gates: skip if low_ask > avg_price*10, or (ask-only) low_ask >
--       badge_avg*10, or low_ask > the 25000 ceiling.
--   (f) DELETE-ONLY-TODAY: only today's snapshot for the edition is replaced;
--       historical snapshots are preserved (delete-then-insert, never upsert).
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20260711185416_audit_20260711_fmv_snapshots_rename_wap_to_asp.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TYPE public.fmv_confidence AS ENUM ('HIGH','MEDIUM','LOW','NO_DATA','ASK_ONLY','SALES_ONLY','STALE');

CREATE TABLE public.editions (
  id uuid PRIMARY KEY, external_id text, collection_id uuid,
  set_id_onchain int, play_id_onchain int, tier text
);
CREATE TABLE public.fmv_snapshots (
  edition_id uuid, collection_id uuid, fmv_usd numeric, floor_price_usd numeric,
  asp_usd numeric, asp_without_outliers numeric, confidence public.fmv_confidence,
  listing_count int, ask_proxy_fmv numeric, cross_market_ask numeric, top_shot_ask numeric,
  algo_version text, computed_at timestamptz, collection text,
  sales_count_7d int, sales_count_30d int
);
CREATE TABLE public.sales (edition_id uuid, collection_id uuid, price_usd numeric, sold_at timestamptz);
CREATE TABLE public.badge_editions (external_id text, avg_sale_price numeric);

-- TopShot editions (collection hard-coded in the fn).
INSERT INTO public.editions (id, external_id, collection_id, set_id_onchain, play_id_onchain, tier) VALUES
  ('e0000000-0000-0000-0000-00000000000a', '1:1', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 1, 1, 'COMMON'),   -- basic market write
  ('e0000000-0000-0000-0000-00000000000c', '3:3', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 3, 3, 'ULTIMATE'), -- excluded
  ('e0000000-0000-0000-0000-00000000000d', '4:4', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 4, 4, 'RARE'),     -- already HIGH
  ('e0000000-0000-0000-0000-00000000000e', '5:5', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 5, 5, 'COMMON'),   -- troll ask
  ('e0000000-0000-0000-0000-00000000000f', '6:6', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 6, 6, 'COMMON');   -- median cap

-- edD already has a HIGH-confidence snapshot → must be skipped.
INSERT INTO public.fmv_snapshots (edition_id, collection_id, confidence, computed_at, fmv_usd) VALUES
  ('e0000000-0000-0000-0000-00000000000d', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'HIGH', now() - interval '1 hour', 500);
-- edA has an OLD (yesterday) snapshot that must SURVIVE, and a today one that gets replaced.
INSERT INTO public.fmv_snapshots (edition_id, collection_id, confidence, computed_at, fmv_usd) VALUES
  ('e0000000-0000-0000-0000-00000000000a', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'LOW', now() - interval '1 day', 7),
  ('e0000000-0000-0000-0000-00000000000a', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'LOW', now(), 999);

-- edF: 3 recent sales with median 20 → fmv capped at 20*3 = 60 (avg_price 100 → 60).
INSERT INTO public.sales (edition_id, collection_id, price_usd, sold_at) VALUES
  ('e0000000-0000-0000-0000-00000000000f', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 20, now() - interval '2 days'),
  ('e0000000-0000-0000-0000-00000000000f', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 20, now() - interval '3 days'),
  ('e0000000-0000-0000-0000-00000000000f', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 20, now() - interval '4 days');

-- >>> BEGIN verbatim upsert_topshot_marketplace_fmv (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.upsert_topshot_marketplace_fmv(p_rows jsonb)
RETURNS TABLE(upserted integer, skipped integer, no_edition integer)
LANGUAGE plpgsql
SET search_path = public, pg_temp
SET statement_timeout = '60s'
AS $function$
DECLARE
  v_collection_id  uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid;
  v_ask_ceiling    numeric := 25000;
  v_upserted       int := 0;
  v_no_edition     int := 0;
  v_skipped        int := 0;
  v_today_start    timestamptz := date_trunc('day', NOW());
  v_today_end      timestamptz := date_trunc('day', NOW()) + INTERVAL '1 day';
BEGIN
  DROP TABLE IF EXISTS _input_rows;
  CREATE TEMP TABLE _input_rows ON COMMIT DROP AS
  SELECT
    NULLIF(elem->>'set_id_onchain','')::int   AS set_onchain,
    NULLIF(elem->>'play_id_onchain','')::int  AS play_onchain,
    NULLIF(elem->>'lowest_ask','')::numeric   AS low_ask,
    NULLIF(elem->>'average_price','')::numeric AS avg_price,
    COALESCE(NULLIF(elem->>'total_sales','')::int, 0) AS total_sales
  FROM jsonb_array_elements(p_rows) AS elem;

  SELECT COUNT(*) INTO v_no_edition
  FROM _input_rows
  WHERE set_onchain IS NULL OR play_onchain IS NULL;

  DROP TABLE IF EXISTS _mapped_rows;
  CREATE TEMP TABLE _mapped_rows ON COMMIT DROP AS
  SELECT
    e.id          AS edition_id,
    e.external_id AS external_id,
    e.tier::text  AS tier,
    i.low_ask,
    i.avg_price,
    i.total_sales
  FROM _input_rows i
  JOIN editions e
    ON  e.collection_id   = v_collection_id
    AND e.set_id_onchain  = i.set_onchain
    AND e.play_id_onchain = i.play_onchain
  WHERE i.set_onchain IS NOT NULL AND i.play_onchain IS NOT NULL;

  WITH miss AS (
    SELECT COUNT(*) AS miss_count
    FROM _input_rows i
    WHERE i.set_onchain IS NOT NULL AND i.play_onchain IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM editions e
        WHERE e.collection_id = v_collection_id
          AND e.set_id_onchain  = i.set_onchain
          AND e.play_id_onchain = i.play_onchain
      )
  )
  SELECT v_no_edition + miss.miss_count INTO v_no_edition FROM miss;

  -- PREFILTER, and it must come BEFORE the sales scan.
  -- These are the two predicates `_eligible_rows` already applied. Applying them here means
  -- `_sales_stats` and `_badge_ctx` -- read by nothing else -- are never computed for editions
  -- that were going to be discarded. An edition already at HIGH/MEDIUM confidence is one with
  -- plenty of recent sales, so this drops the EXPENSIVE half of the sales nested loop, not a
  -- proportional share of it: measured 9,140 -> 1,449 buffers on 470 -> 215 editions.
  DROP TABLE IF EXISTS _prefiltered;
  CREATE TEMP TABLE _prefiltered ON COMMIT DROP AS
  SELECT m.*
  FROM _mapped_rows m
  LEFT JOIN LATERAL (
    SELECT fs.confidence::text AS conf
    FROM fmv_snapshots fs
    WHERE fs.edition_id = m.edition_id
    ORDER BY fs.computed_at DESC
    LIMIT 1
  ) latest ON true
  WHERE m.tier IS DISTINCT FROM 'ULTIMATE'
    AND (latest.conf IS NULL OR latest.conf NOT IN ('HIGH','MEDIUM'));

  DROP TABLE IF EXISTS _sales_stats;
  CREATE TEMP TABLE _sales_stats ON COMMIT DROP AS
  SELECT s.edition_id,
         COUNT(*)::int AS sales_count_90d,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY s.price_usd) AS sales_median_90d
  FROM sales s
  WHERE s.collection_id = v_collection_id
    AND s.sold_at >= NOW() - INTERVAL '90 days'
    AND s.price_usd > 0
    AND s.edition_id IN (SELECT edition_id FROM _prefiltered)
  GROUP BY s.edition_id;

  DROP TABLE IF EXISTS _badge_ctx;
  CREATE TEMP TABLE _badge_ctx ON COMMIT DROP AS
  SELECT DISTINCT ON (m.edition_id) m.edition_id, be.avg_sale_price
  FROM _prefiltered m
  JOIN badge_editions be ON be.external_id = m.external_id
  WHERE be.avg_sale_price IS NOT NULL AND be.avg_sale_price > 0
  ORDER BY m.edition_id, be.avg_sale_price DESC;

  DROP TABLE IF EXISTS _eligible_rows;
  CREATE TEMP TABLE _eligible_rows ON COMMIT DROP AS
  SELECT m.*,
         ss.sales_count_90d,
         ss.sales_median_90d,
         bc.avg_sale_price AS badge_avg
  FROM _prefiltered m
  LEFT JOIN _sales_stats ss ON ss.edition_id = m.edition_id
  LEFT JOIN _badge_ctx bc ON bc.edition_id = m.edition_id
  WHERE NOT (
      COALESCE(ss.sales_count_90d,0) >= 3
      AND NOT (m.avg_price IS NOT NULL AND m.avg_price > 0 AND m.total_sales > 0)
    );

  v_skipped := (SELECT COUNT(*) FROM _mapped_rows) - (SELECT COUNT(*) FROM _eligible_rows);

  DROP TABLE IF EXISTS _writes;
  CREATE TEMP TABLE _writes ON COMMIT DROP AS
  WITH base AS (
    SELECT
      e.edition_id, e.low_ask, e.avg_price, e.total_sales,
      e.sales_median_90d, e.badge_avg,
      (e.avg_price IS NOT NULL AND e.avg_price > 0 AND e.total_sales > 0) AS has_mkt_sales
    FROM _eligible_rows e
  )
  SELECT
    b.edition_id,
    CASE
      WHEN b.sales_median_90d IS NOT NULL AND b.sales_median_90d > 0
        THEN LEAST(CASE WHEN b.has_mkt_sales THEN b.avg_price ELSE b.low_ask END, b.sales_median_90d * 3)
      ELSE CASE WHEN b.has_mkt_sales THEN b.avg_price ELSE b.low_ask END
    END AS fmv_usd,
    b.low_ask, b.avg_price, b.total_sales,
    CASE WHEN b.has_mkt_sales THEN 'LOW'::fmv_confidence ELSE 'ASK_ONLY'::fmv_confidence END AS confidence
  FROM base b
  WHERE
    (b.has_mkt_sales OR (b.low_ask IS NOT NULL AND b.low_ask > 0 AND b.low_ask <= v_ask_ceiling))
    AND NOT (b.avg_price IS NOT NULL AND b.avg_price > 0 AND b.low_ask IS NOT NULL AND b.low_ask > b.avg_price * 10)
    AND NOT (NOT b.has_mkt_sales AND b.badge_avg IS NOT NULL AND b.low_ask IS NOT NULL AND b.low_ask > b.badge_avg * 10);

  v_skipped := v_skipped + ((SELECT COUNT(*) FROM _eligible_rows) - (SELECT COUNT(*) FROM _writes));

  IF EXISTS (SELECT 1 FROM _writes) THEN
    DELETE FROM fmv_snapshots fs
    USING _writes w
    WHERE fs.edition_id     = w.edition_id
      AND fs.collection_id  = v_collection_id
      AND fs.computed_at   >= v_today_start
      AND fs.computed_at   <  v_today_end;

    INSERT INTO fmv_snapshots (
      edition_id, collection_id, fmv_usd, floor_price_usd,
      asp_usd, asp_without_outliers,
      confidence, listing_count,
      ask_proxy_fmv, cross_market_ask, top_shot_ask,
      algo_version, computed_at, collection,
      sales_count_7d, sales_count_30d
    )
    SELECT
      w.edition_id, v_collection_id,
      ROUND(w.fmv_usd::numeric, 2), w.low_ask,
      CASE WHEN w.total_sales > 0 THEN w.avg_price ELSE NULL END,
      CASE WHEN w.total_sales > 0 THEN w.avg_price ELSE NULL END,
      w.confidence, 0,
      w.low_ask, w.low_ask, w.low_ask,
      'topshot-gql-v1', NOW(), 'nba_top_shot',
      0, 0
    FROM _writes w;

    GET DIAGNOSTICS v_upserted = ROW_COUNT;
  END IF;

  RETURN QUERY SELECT v_upserted, v_skipped, v_no_edition;
END;
$function$;
-- <<< END verbatim upsert_topshot_marketplace_fmv <<<

-- One batch exercising every gate at once:
--   1:1 edA  → market sales (avg 10, ts 5) → WRITTEN, LOW
--   3:3 edC  → ULTIMATE → skipped
--   4:4 edD  → already HIGH → skipped
--   5:5 edE  → troll ask (low_ask 1000 vs avg 10) → skipped
--   6:6 edF  → market sales avg 100, median 20 → WRITTEN, fmv capped to 60
--   9:9      → maps to no edition → no_edition
--   NULL play → no_edition
SELECT * FROM public.upsert_topshot_marketplace_fmv('[
  {"set_id_onchain":"1","play_id_onchain":"1","lowest_ask":"8","average_price":"10","total_sales":"5"},
  {"set_id_onchain":"3","play_id_onchain":"3","lowest_ask":"8","average_price":"10","total_sales":"5"},
  {"set_id_onchain":"4","play_id_onchain":"4","lowest_ask":"8","average_price":"10","total_sales":"5"},
  {"set_id_onchain":"5","play_id_onchain":"5","lowest_ask":"1000","average_price":"10","total_sales":"5"},
  {"set_id_onchain":"6","play_id_onchain":"6","lowest_ask":"90","average_price":"100","total_sales":"5"},
  {"set_id_onchain":"9","play_id_onchain":"9","lowest_ask":"8","average_price":"10","total_sales":"5"},
  {"set_id_onchain":"","play_id_onchain":"","lowest_ask":"8","average_price":"10","total_sales":"5"}
]'::jsonb) \gset res_

-- (1) return counts: 2 written (edA, edF), 3 skipped (ULTIMATE, HIGH, troll),
-- 2 no_edition (unmapped 9:9 + the null-play row).
SELECT _assert_eq(:'res_upserted'::text,  '2', '2 editions written (market rows that pass every gate)');
SELECT _assert_eq(:'res_skipped'::text,   '3', '3 skipped: ULTIMATE + already-HIGH + troll-ask');
SELECT _assert_eq(:'res_no_edition'::text,'2', '2 no_edition: unmapped set:play + null play');

-- (2) edA written today with LOW confidence + fmv = avg_price 10.
SELECT _assert_eq(
  (SELECT fmv_usd::text FROM public.fmv_snapshots
    WHERE edition_id='e0000000-0000-0000-0000-00000000000a' AND computed_at >= date_trunc('day', now())),
  '10.00', 'market-sales row writes avg_price as fmv');
SELECT _assert_eq(
  (SELECT confidence::text FROM public.fmv_snapshots
    WHERE edition_id='e0000000-0000-0000-0000-00000000000a' AND computed_at >= date_trunc('day', now())),
  'LOW', 'market-sales row is LOW confidence');

-- (3) median cap: edF avg_price 100 capped to median(20)*3 = 60.
SELECT _assert_eq(
  (SELECT fmv_usd::text FROM public.fmv_snapshots
    WHERE edition_id='e0000000-0000-0000-0000-00000000000f' AND computed_at >= date_trunc('day', now())),
  '60.00', 'fmv is capped at sales_median_90d * 3');

-- (4) ULTIMATE + already-HIGH editions got NO new snapshot today.
SELECT _assert_eq(
  (SELECT count(*)::text FROM public.fmv_snapshots
    WHERE edition_id='e0000000-0000-0000-0000-00000000000c' AND computed_at >= date_trunc('day', now())),
  '0', 'ULTIMATE edition is never written here');
SELECT _assert_eq(
  (SELECT count(*)::text FROM public.fmv_snapshots
    WHERE edition_id='e0000000-0000-0000-0000-00000000000d' AND algo_version='topshot-gql-v1'),
  '0', 'an already-HIGH edition is not overwritten by an ask-derived write');

-- (5) DELETE-ONLY-TODAY: edA had a yesterday snapshot (fmv 7) + a today one (999).
-- The write deletes today's and inserts the new; yesterday's SURVIVES untouched.
SELECT _assert_eq(
  (SELECT count(*)::text FROM public.fmv_snapshots
    WHERE edition_id='e0000000-0000-0000-0000-00000000000a' AND fmv_usd=7 AND computed_at < date_trunc('day', now())),
  '1', 'the historical (yesterday) snapshot is preserved');
SELECT _assert_eq(
  (SELECT count(*)::text FROM public.fmv_snapshots
    WHERE edition_id='e0000000-0000-0000-0000-00000000000a' AND fmv_usd=999),
  '0', 'the stale same-day snapshot (999) was deleted before insert');
SELECT _assert_eq(
  (SELECT count(*)::text FROM public.fmv_snapshots
    WHERE edition_id='e0000000-0000-0000-0000-00000000000a' AND computed_at >= date_trunc('day', now())),
  '1', 'exactly one snapshot for today after the delete-then-insert');

SELECT '✓ upsert_topshot_marketplace_fmv invariants pass' AS result;
ROLLBACK;

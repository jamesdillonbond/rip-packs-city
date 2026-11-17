-- audit_20260828_topshot_fmv_populate_prefilters_before_the_sales_scan
--
-- `topshot-fmv-populate` had gone 17.7 h without a success when this was found, and NOTHING
-- reported it (see docs/overnight/inbox/ — detect_stalled_pipelines reads max(started_at) with
-- no `ok` filter, so a pipeline that fires on time and fails every time reads as healthy).
-- The two most recent ticks failed for DIFFERENT reasons:
--   · 2026-08-28 19:38Z  `http 503` from the Top Shot GQL feed  -- upstream, not ours
--   · 2026-08-28 13:38Z  `canceling statement due to statement timeout` after 73,136 ms
-- This migration addresses ONLY the second. The 503 is the separate Top Shot outage.
--
-- ── WHAT ACTUALLY TIMES OUT ─────────────────────────────────────────────────
-- The route calls this RPC once per sweep with the whole feed (183 nodes -> ~470 mapped
-- editions, well under the caller's 500-row chunk, so chunking never engages). Reproduced on
-- the live instance against an UNANALYZED scratch table of 470 Top Shot editions -- reltuples
-- = -1, exactly like the temp table this function builds -- the `_sales_stats` step alone
-- exceeded 60 s COLD and could not be EXPLAIN ANALYZEd inside a 60 s budget. That step is the
-- whole cost: 470 nested-loop probes into `sales`, each fetching ~18 rows off distinct heap
-- pages. Warm it is 647 ms; cold, at ~6 ms per random page read, it is the run.
-- That is also the recorded variance: the same 183-node sweep has taken 5,845 ms and 73,136 ms.
--
-- ── THE FIX: FILTER FIRST, THEN SCAN ────────────────────────────────────────
-- `_sales_stats` and `_badge_ctx` were computed over ALL of `_mapped_rows`, but BOTH are read
-- only by `_eligible_rows`, which then throws away every edition whose latest fmv_snapshot is
-- already HIGH/MEDIUM (and every ULTIMATE). So the function was paying for sales medians it
-- had already decided to discard.
--
-- ⭐ The reduction is much larger than the row count predicts, and the mechanism is the point:
-- an edition already priced HIGH/MEDIUM is one with plenty of recent sales. The confidence
-- filter removes precisely the SALES-HEAVY editions -- the expensive half of the nested loop.
--
-- ── MEASURED, ANALYZE + BUFFERS on the live instance, WARM vs WARM ──────────
--   `_sales_stats` leg    470 editions -> 9,140 buffers (8,176 hit / 964 read), 8,264 sales rows
--                         215 editions -> 1,449 buffers (1,210 hit / 239 read),   818 sales rows
--                         => buffers -84%, sales rows scanned -90%, COLD reads 964 -> 239
--   `_badge_ctx` leg      470 editions -> 1,268 buffers; scales with the same 470 -> 215 cut
--   `latest.conf` lateral 470 editions -> 2,841 buffers / 173 ms -- unchanged, just MOVED
--   whole-function warm buffers: ~13,249 -> ~4,870 (-63%)
--   ⚠ Single samples on a shared instance. The BUFFER counts are the durable comparison; the
--     wall-clock ratio moves with load and must not be quoted as a guarantee.
--   ⚠ The 470/215 split is from a HASH-SAMPLED 470 Top Shot editions, not the feed's own 470
--     (the feed was 503ing when this was measured). The mechanism -- HIGH/MEDIUM editions are
--     the sales-heavy ones -- is what generalises; the exact 84% will move run to run.
--
-- ── EQUIVALENCE ─────────────────────────────────────────────────────────────
-- `_prefiltered` applies EXACTLY the two predicates `_eligible_rows` already applied, and no
-- others: `tier IS DISTINCT FROM 'ULTIMATE'` and the latest-confidence test. `_sales_stats`
-- and `_badge_ctx` are consumed nowhere else in this function, so for every row that survives
-- into `_eligible_rows` both are populated exactly as before, and rows that do not survive are
-- discarded either way.
--   · `v_skipped`'s first term is `count(_mapped_rows) - count(_eligible_rows)`; NEITHER count
--     changes, so the reported skip figure is byte-identical. The second term likewise.
--   · The LATERAL is `LIMIT 1 ... ON true`, so it cannot fan out; moving it earlier cannot
--     change row multiplicity.
--   · `_prefiltered` is `SELECT m.*` of `_mapped_rows`, so `_eligible_rows`'s column list,
--     order and types are unchanged -- and `upserted / skipped / no_edition` is the function's
--     RETURNS TABLE, untouched.
--
-- ⚠ `SET statement_timeout = '60s'` and `SET search_path` are LOAD-BEARING and re-declared
-- verbatim: CREATE OR REPLACE FUNCTION drops any proconfig not restated. 60s is ABOVE
-- service_role's own 30s, and per docs/reference/database.md a HIGHER declaration RAISES the
-- bound over PostgREST -- dropping it silently halves the budget to 30s.
-- ⚠ SECURITY INVOKER (prosecdef=false) is preserved by omitting SECURITY DEFINER.
-- anon-exec: unchanged (upsert_topshot_marketplace_fmv) -- CREATE OR REPLACE of an existing
-- function does not touch its ACL; verified before this migration as anon=false,
-- authenticated=false, service_role=true, and re-verified after.
--
-- REVERT: re-create the function with `_sales_stats` and `_badge_ctx` selecting FROM
-- `_mapped_rows` again and the confidence/tier predicates back in `_eligible_rows`'s WHERE,
-- i.e. drop the `_prefiltered` temp table. No data is written or destroyed by this change.
--
-- EXIT CONDITION: `topshot-fmv-populate` stops logging `canceling statement due to statement
-- timeout` in pipeline_runs. Baseline: 2 of the 12 runs retained on 2026-08-28 (08-26 and
-- 08-28), i.e. ~17%; duration_ms on the OK runs ranged 5,845 - 60,222.
-- FALSIFIER: if timeouts keep accruing at this rate, the cost is not `_sales_stats` but the
-- DELETE+INSERT into `fmv_snapshots`, which this change does not touch.

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

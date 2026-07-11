-- audit_20260711_fmv_snapshots_rename_wap_to_asp
--
-- Completes the user-facing "WAP" -> "Avg Sales Price" (ASP) rename by renaming
-- the physical fmv_snapshots columns and updating every DB object that touches
-- them. Companion API/JS-layer rename shipped alongside (wapUsd/wapClean ->
-- aspUsd/aspClean response keys + all direct fmv_snapshots readers/writers).
--
-- Scope: ONLY fmv_snapshots (partitioned parent -> _2025/_2026/_2027). The
-- separate pinnacle_catalog.fmv_wap_usd column is a DIFFERENT concept and is
-- intentionally NOT touched here.
--
-- Technique: physical columns become asp_usd / asp_without_outliers. Reader
-- functions alias the new column back to the old name at the source
-- (asp_usd AS wap_usd) so downstream jsonb output keys and RETURNS-column names
-- are 100% unchanged — no consumer of any DB-function output contract breaks.
-- Writer functions change only the INSERT column lists (positional source
-- expressions unchanged). The fmv_current view is auto-rewritten by Postgres on
-- RENAME and keeps its output column named wap_usd (no action needed).
--
-- Revert:
--   ALTER TABLE public.fmv_snapshots RENAME COLUMN asp_usd TO wap_usd;
--   ALTER TABLE public.fmv_snapshots RENAME COLUMN asp_without_outliers TO wap_without_outliers;
--   + re-apply the prior function definitions from migration history.

-- ── 1) Physical column rename (propagates to all partitions) ────────────────
ALTER TABLE public.fmv_snapshots RENAME COLUMN wap_usd TO asp_usd;
ALTER TABLE public.fmv_snapshots RENAME COLUMN wap_without_outliers TO asp_without_outliers;

-- ── 2) Trigger: fmv_snapshots_block_phantoms (NEW.wap_usd -> NEW.asp_usd) ────
CREATE OR REPLACE FUNCTION public.fmv_snapshots_block_phantoms()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_collection_id uuid;
BEGIN
  IF NEW.fmv_usd > 10000
     AND NOT (NEW.confidence::text = 'HIGH' AND COALESCE(NEW.sales_count_30d, 0) >= 3) THEN
    -- Look up collection_id from edition for the audit row
    SELECT collection_id INTO v_collection_id FROM editions WHERE id = NEW.edition_id;

    -- Audit-log what would have been written
    INSERT INTO fmv_phantom_attempts (
      edition_id, collection_id, attempted_fmv, attempted_wap, attempted_floor,
      confidence, sales_count_30d, source_route
    )
    VALUES (
      NEW.edition_id, v_collection_id, NEW.fmv_usd, NEW.asp_usd, NEW.floor_price_usd,
      NEW.confidence::text, NEW.sales_count_30d, 'trigger_intercept'
    );

    -- Null the phantom values, preserving the audit row
    NEW.fmv_usd := NULL;
    NEW.asp_usd := NULL;
    NEW.floor_price_usd := NULL;
  END IF;
  RETURN NEW;
END;
$function$;

-- ── 3) Writers (INSERT column lists wap_* -> asp_*) ─────────────────────────

CREATE OR REPLACE FUNCTION public.upsert_topshot_marketplace_fmv(p_rows jsonb)
 RETURNS TABLE(upserted integer, skipped integer, no_edition integer)
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '60s'
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

  -- Per-edition trailing 90d sales stats from our on-chain sales table.
  DROP TABLE IF EXISTS _sales_stats;
  CREATE TEMP TABLE _sales_stats ON COMMIT DROP AS
  SELECT s.edition_id,
         COUNT(*)::int AS sales_count_90d,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY s.price_usd) AS sales_median_90d
  FROM sales s
  WHERE s.collection_id = v_collection_id
    AND s.sold_at >= NOW() - INTERVAL '90 days'
    AND s.price_usd > 0
    AND s.edition_id IN (SELECT edition_id FROM _mapped_rows)
  GROUP BY s.edition_id;

  -- badge_editions avg sale context for the zero-sale troll-ask gate.
  DROP TABLE IF EXISTS _badge_ctx;
  CREATE TEMP TABLE _badge_ctx ON COMMIT DROP AS
  SELECT DISTINCT ON (m.edition_id) m.edition_id, be.avg_sale_price
  FROM _mapped_rows m
  JOIN badge_editions be ON be.external_id = m.external_id
  WHERE be.avg_sale_price IS NOT NULL AND be.avg_sale_price > 0
  ORDER BY m.edition_id, be.avg_sale_price DESC;

  DROP TABLE IF EXISTS _eligible_rows;
  CREATE TEMP TABLE _eligible_rows ON COMMIT DROP AS
  SELECT m.*,
         ss.sales_count_90d,
         ss.sales_median_90d,
         bc.avg_sale_price AS badge_avg
  FROM _mapped_rows m
  LEFT JOIN LATERAL (
    SELECT fs.confidence::text AS conf
    FROM fmv_snapshots fs
    WHERE fs.edition_id = m.edition_id
    ORDER BY fs.computed_at DESC
    LIMIT 1
  ) latest ON true
  LEFT JOIN _sales_stats ss ON ss.edition_id = m.edition_id
  LEFT JOIN _badge_ctx bc ON bc.edition_id = m.edition_id
  WHERE m.tier IS DISTINCT FROM 'ULTIMATE'
    AND (latest.conf IS NULL OR latest.conf NOT IN ('HIGH','MEDIUM'))
    -- sales-precedence: skip ask-derived writes for editions with real sales
    AND NOT (
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

CREATE OR REPLACE FUNCTION public.upsert_allday_marketplace_fmv(p_rows jsonb)
 RETURNS TABLE(upserted integer, skipped integer, no_edition integer)
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_collection_id  uuid := 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid;
  v_ask_ceiling    numeric := 5000;
  v_upserted       int := 0;
  v_no_edition     int := 0;
  v_skipped        int := 0;
  v_today_start    timestamptz := date_trunc('day', NOW());
  v_today_end      timestamptz := date_trunc('day', NOW()) + INTERVAL '1 day';
BEGIN
  DROP TABLE IF EXISTS _input_rows;
  CREATE TEMP TABLE _input_rows ON COMMIT DROP AS
  SELECT
    COALESCE(elem->>'edition_flow_id', elem->>'editionFlowID')::text AS ext_id,
    NULLIF(COALESCE(elem->>'lowest_price', elem->>'lowestPrice'), '')::numeric  AS low_price,
    NULLIF(COALESCE(elem->>'average_sale', elem->>'averageSale'), '')::numeric  AS avg_sale,
    COALESCE(
      NULLIF(elem->>'total_listings', '')::int,
      NULLIF(elem->>'totalListings', '')::int,
      0
    ) AS total_list
  FROM jsonb_array_elements(p_rows) AS elem;

  DROP TABLE IF EXISTS _mapped_rows;
  CREATE TEMP TABLE _mapped_rows ON COMMIT DROP AS
  SELECT
    e.id AS edition_id,
    i.low_price,
    i.avg_sale,
    i.total_list
  FROM _input_rows i
  JOIN editions e
    ON  e.collection_id = v_collection_id
    AND e.external_id   = i.ext_id
  WHERE i.ext_id IS NOT NULL;

  v_no_edition := (
    SELECT COUNT(*) FROM _input_rows WHERE ext_id IS NULL
  ) + (
    SELECT COUNT(*) FROM _input_rows i
    WHERE i.ext_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM editions e
        WHERE e.collection_id = v_collection_id AND e.external_id = i.ext_id
      )
  );

  DROP TABLE IF EXISTS _eligible_rows;
  CREATE TEMP TABLE _eligible_rows ON COMMIT DROP AS
  SELECT m.*
  FROM _mapped_rows m
  LEFT JOIN LATERAL (
    SELECT fs.confidence::text AS conf
    FROM fmv_snapshots fs
    WHERE fs.edition_id = m.edition_id
    ORDER BY fs.computed_at DESC
    LIMIT 1
  ) latest ON true
  WHERE (latest.conf IS NULL OR latest.conf NOT IN ('HIGH','MEDIUM'));

  v_skipped := (SELECT COUNT(*) FROM _mapped_rows) - (SELECT COUNT(*) FROM _eligible_rows);

  DROP TABLE IF EXISTS _writes;
  CREATE TEMP TABLE _writes ON COMMIT DROP AS
  SELECT
    e.edition_id,
    CASE WHEN e.avg_sale IS NOT NULL AND e.avg_sale > 0 THEN e.avg_sale
         ELSE e.low_price
    END AS fmv_usd,
    e.low_price,
    e.avg_sale,
    e.total_list,
    CASE WHEN e.avg_sale IS NOT NULL AND e.avg_sale > 0 THEN 'LOW'::fmv_confidence
         ELSE 'ASK_ONLY'::fmv_confidence
    END AS confidence
  FROM _eligible_rows e
  WHERE
    (e.avg_sale IS NOT NULL AND e.avg_sale > 0)
    OR (e.low_price IS NOT NULL AND e.low_price > 0 AND e.low_price <= v_ask_ceiling);

  v_skipped := v_skipped + ((SELECT COUNT(*) FROM _eligible_rows) - (SELECT COUNT(*) FROM _writes));

  IF EXISTS (SELECT 1 FROM _writes) THEN
    DELETE FROM fmv_snapshots fs
    USING _writes w
    WHERE fs.edition_id    = w.edition_id
      AND fs.collection_id = v_collection_id
      AND fs.computed_at  >= v_today_start
      AND fs.computed_at  <  v_today_end;

    INSERT INTO fmv_snapshots (
      edition_id, collection_id, fmv_usd, floor_price_usd,
      asp_usd, asp_without_outliers,
      confidence, listing_count,
      ask_proxy_fmv, cross_market_ask,
      algo_version, computed_at, collection,
      sales_count_7d, sales_count_30d
    )
    SELECT
      w.edition_id, v_collection_id,
      w.fmv_usd, w.low_price,
      CASE WHEN w.avg_sale > 0 THEN w.avg_sale ELSE NULL END,
      CASE WHEN w.avg_sale > 0 THEN w.avg_sale ELSE NULL END,
      w.confidence, w.total_list,
      w.low_price, w.low_price,
      'allday-gql-v1', NOW(), 'nfl_all_day',
      0, 0
    FROM _writes w;

    GET DIAGNOSTICS v_upserted = ROW_COUNT;
  END IF;

  RETURN QUERY SELECT v_upserted, v_skipped, v_no_edition;
END;
$function$;

CREATE OR REPLACE FUNCTION public.apply_fmv_thin_sales_guard(p_mode text DEFAULT 'dry_run'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_thin_sales_count INT := 0;
  v_stale_count INT := 0;
  v_common_outlier_count INT := 0;
  v_skipped_already_capped INT := 0;
  v_total_examined INT := 0;
  rec RECORD;
  v_cap NUMERIC;
  v_reason TEXT;
  v_new_confidence TEXT;
  v_can_use_ask BOOLEAN;
  v_fresh_ask NUMERIC;
BEGIN
  IF p_mode NOT IN ('dry_run','live') THEN
    RAISE EXCEPTION 'p_mode must be dry_run or live, got %', p_mode;
  END IF;

  FOR rec IN
    WITH latest AS (
      SELECT DISTINCT ON (edition_id)
        fs.edition_id, fs.collection_id, fs.fmv_usd, fs.asp_usd AS wap_usd,
        fs.asp_without_outliers AS wap_without_outliers, fs.ask_proxy_fmv,
        fs.top_shot_ask, fs.flowty_ask, fs.cross_market_ask,
        fs.sales_count_7d, fs.sales_count_30d, fs.confidence,
        fs.algo_version, fs.computed_at, fs.floor_price_usd, fs.listing_count,
        fs.days_since_sale, fs.unique_buyers_30d, fs.offer_count,
        fs.velocity_factor, fs.utility_factor, fs.loan_factor
      FROM fmv_snapshots fs
      ORDER BY edition_id, computed_at DESC
    )
    SELECT l.*, e.tier, e.set_name, e.external_id, c.slug AS collection_slug
    FROM latest l
    JOIN editions e ON e.id = l.edition_id
    JOIN collections c ON c.id = l.collection_id
    WHERE l.fmv_usd > 200
      AND l.confidence::text <> 'ASK_ONLY'  -- honest ask-derived rows are owned by fmv-recalc; never re-process them
  LOOP
    v_total_examined := v_total_examined + 1;
    IF rec.algo_version IN ('thin-sales-guard-v1', 'thin-sales-guard-v2', 'thin-sales-guard-v3') THEN
      v_skipped_already_capped := v_skipped_already_capped + 1;
      CONTINUE;
    END IF;

    v_cap := NULL;
    v_reason := NULL;
    v_new_confidence := NULL;

    -- Live TS marketplace ask (badge_editions.low_ask, refreshed every 6h),
    -- looked up once for all branches below.
    SELECT b.low_ask INTO v_fresh_ask
    FROM editions e3
    JOIN badge_editions b ON b.external_id = e3.external_id AND b.collection_id = e3.collection_id
    WHERE e3.id = rec.edition_id AND b.low_ask > 0 AND b.low_ask <= 10000
    ORDER BY b.low_ask ASC
    LIMIT 1;

    -- Reason 3: COMMON/FANDOM outlier (skip if a fresh ask supports the value)
    IF rec.tier IN ('COMMON','FANDOM') AND rec.fmv_usd > 500 AND COALESCE(rec.sales_count_7d, 0) <= 1 THEN
      SELECT PERCENTILE_CONT(0.90) WITHIN GROUP (ORDER BY l2.fmv_usd) INTO v_cap
      FROM (
        SELECT DISTINCT ON (edition_id) edition_id, fmv_usd
        FROM fmv_snapshots fs2
        JOIN editions e2 ON e2.id = fs2.edition_id
        WHERE e2.set_name = rec.set_name AND e2.tier = rec.tier
          AND fs2.collection_id = rec.collection_id
          AND fs2.edition_id <> rec.edition_id
          AND fs2.fmv_usd IS NOT NULL AND fs2.fmv_usd > 0
        ORDER BY edition_id, computed_at DESC
      ) l2;
      IF v_cap IS NOT NULL AND v_cap < rec.fmv_usd THEN
        v_cap := GREATEST(v_cap * 5, 50);
        v_cap := LEAST(v_cap, rec.fmv_usd);
        IF v_fresh_ask IS NOT NULL AND ROUND(v_fresh_ask * 0.90, 2) >= v_cap THEN
          v_cap := NULL;  -- fresh ask supports the value; not an outlier, defer to Reason 2
        ELSE
          v_reason := 'common_fandom_outlier';
          v_new_confidence := 'LOW';
          v_common_outlier_count := v_common_outlier_count + 1;
        END IF;
      END IF;
    END IF;

    -- Reason 1: thin-sales WAP outlier
    IF v_cap IS NULL AND v_reason IS NULL AND COALESCE(rec.sales_count_7d, 0) <= 3 AND rec.wap_without_outliers IS NOT NULL THEN
      IF rec.fmv_usd > rec.wap_without_outliers * 5 THEN
        v_can_use_ask := rec.ask_proxy_fmv IS NOT NULL
                       AND rec.ask_proxy_fmv > rec.fmv_usd * 0.30
                       AND rec.ask_proxy_fmv < rec.fmv_usd;
        IF v_can_use_ask THEN
          v_cap := rec.ask_proxy_fmv * 1.5;
          v_reason := 'thin_sales_ask_capped';
        ELSE
          v_cap := rec.wap_without_outliers;
          v_reason := 'thin_sales_wap_capped';
        END IF;
        v_cap := LEAST(v_cap, rec.fmv_usd);
        v_new_confidence := 'MEDIUM';
        v_thin_sales_count := v_thin_sales_count + 1;
      END IF;
    END IF;

    -- Reason 2: stale 30-day holdover. Fresh TS ask supersedes a >30d-stale WAP.
    IF v_cap IS NULL AND v_reason IS NULL AND COALESCE(rec.sales_count_30d, 0) = 0 AND rec.fmv_usd > 200 THEN
      IF v_fresh_ask IS NOT NULL THEN
        v_cap := ROUND(v_fresh_ask * 0.90, 2);
        v_reason := 'stale_30d_fresh_ask';
        v_new_confidence := 'ASK_ONLY';
      ELSIF rec.ask_proxy_fmv IS NOT NULL AND rec.ask_proxy_fmv > 50 THEN
        v_cap := LEAST(rec.ask_proxy_fmv * 1.5, rec.fmv_usd);
        v_reason := 'stale_30d_ask_capped';
        v_new_confidence := 'STALE';
      ELSE
        v_cap := rec.fmv_usd;
        v_reason := 'stale_30d_no_ask';
        v_new_confidence := 'STALE';
      END IF;
      v_stale_count := v_stale_count + 1;
    END IF;

    IF v_cap IS NOT NULL AND v_reason IS NOT NULL AND p_mode = 'live' THEN
      INSERT INTO fmv_snapshots (
        edition_id, collection_id, fmv_usd, floor_price_usd,
        asp_usd, asp_without_outliers, ask_proxy_fmv, confidence,
        top_shot_ask, flowty_ask, cross_market_ask,
        sales_count_7d, sales_count_30d, unique_buyers_30d, offer_count, listing_count,
        days_since_sale, velocity_factor, utility_factor, loan_factor,
        algo_version, computed_at
      ) VALUES (
        rec.edition_id, rec.collection_id, v_cap, rec.floor_price_usd,
        rec.wap_usd, rec.wap_without_outliers, COALESCE(v_fresh_ask, rec.ask_proxy_fmv),
        v_new_confidence::fmv_confidence,
        COALESCE(v_fresh_ask, rec.top_shot_ask), rec.flowty_ask, rec.cross_market_ask,
        rec.sales_count_7d, rec.sales_count_30d, rec.unique_buyers_30d,
        rec.offer_count, rec.listing_count,
        rec.days_since_sale, rec.velocity_factor, rec.utility_factor, rec.loan_factor,
        'thin-sales-guard-v3', NOW()
      );

      INSERT INTO fmv_calibration_caps (
        edition_id, collection_id, reason, fmv_before, fmv_after,
        confidence_before, confidence_after, inputs
      ) VALUES (
        rec.edition_id, rec.collection_id, v_reason, rec.fmv_usd, v_cap,
        rec.confidence::TEXT, v_new_confidence,
        jsonb_build_object(
          'tier', rec.tier, 'set_name', rec.set_name,
          'collection_slug', rec.collection_slug,
          'wap_without_outliers', rec.wap_without_outliers,
          'ask_proxy_fmv', rec.ask_proxy_fmv,
          'fresh_ask', v_fresh_ask,
          'sales_count_7d', rec.sales_count_7d,
          'sales_count_30d', rec.sales_count_30d
        )
      )
      ON CONFLICT (edition_id, reason, applied_date) DO UPDATE
        SET applied_at = NOW(),
            fmv_before = EXCLUDED.fmv_before,
            fmv_after = EXCLUDED.fmv_after,
            confidence_before = EXCLUDED.confidence_before,
            confidence_after = EXCLUDED.confidence_after,
            inputs = EXCLUDED.inputs;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'mode', p_mode, 'ran_at', NOW(),
    'algo_version', 'thin-sales-guard-v3',
    'total_examined', v_total_examined,
    'skipped_already_capped', v_skipped_already_capped,
    'thin_sales_count', v_thin_sales_count,
    'stale_count', v_stale_count,
    'common_outlier_count', v_common_outlier_count,
    'total_caps_applied', v_thin_sales_count + v_stale_count + v_common_outlier_count
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.drain_fmv_cold_tail(p_collection_slug text, p_limit integer DEFAULT 200)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '120s'
AS $function$
DECLARE
  v_collection_id   UUID;
  v_processed       INT := 0;
  v_with_sales      INT := 0;
  v_no_data         INT := 0;
  v_ask_only        INT := 0;
  v_stale           INT := 0;
  v_started_at      TIMESTAMPTZ := NOW();
  v_edition_row     RECORD;
  v_median          NUMERIC;
  v_floor           NUMERIC;
  v_ask_floor       NUMERIC;
  v_sales_count_30d INT;
  v_sales_count_7d  INT;
  v_days_since_sale INT;
  v_confidence      TEXT;
  v_hist_median     NUMERIC;
  v_hist_floor      NUMERIC;
  v_hist_last       TIMESTAMPTZ;
  v_hist_n          INT;
BEGIN
  SELECT id INTO v_collection_id FROM collections WHERE slug = p_collection_slug;

  IF v_collection_id IS NULL THEN
    RETURN jsonb_build_object('error', 'unknown collection', 'collection_slug', p_collection_slug);
  END IF;

  FOR v_edition_row IN
    WITH latest AS (
      SELECT edition_id, MAX(computed_at) AS last_snapshot
      FROM fmv_snapshots
      GROUP BY edition_id
    ),
    candidates AS (
      SELECT e.id AS edition_id, e.tier, l.last_snapshot AS last_snapshot
      FROM editions e
      LEFT JOIN latest l ON l.edition_id = e.id
      WHERE e.collection_id = v_collection_id
        -- DUPE1-MIT: never restamp inert UUID-keyed dupe editions (trigger-held,
        -- no on-chain ids). They are not product-priceable rows.
        AND NOT (e.external_id LIKE '%-%' AND e.set_id_onchain IS NULL)
    )
    SELECT edition_id, tier, last_snapshot
    FROM candidates
    WHERE last_snapshot IS NULL OR last_snapshot < NOW() - INTERVAL '7 days'
    ORDER BY
      CASE tier WHEN 'ULTIMATE' THEN 1 WHEN 'LEGENDARY' THEN 2 WHEN 'RARE' THEN 3
                WHEN 'COMMON' THEN 4 WHEN 'FANDOM' THEN 5 ELSE 6 END,
      last_snapshot NULLS FIRST
    LIMIT p_limit
  LOOP
    SELECT
      PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY price_usd),
      MIN(price_usd),
      COUNT(*),
      COUNT(*) FILTER (WHERE sold_at > NOW() - INTERVAL '7 days'),
      EXTRACT(DAY FROM NOW() - MAX(sold_at))::INT
    INTO v_median, v_floor, v_sales_count_30d, v_sales_count_7d, v_days_since_sale
    FROM sales
    WHERE edition_id = v_edition_row.edition_id
      AND sold_at > NOW() - INTERVAL '30 days'
      AND price_usd > 0;

    v_sales_count_30d := COALESCE(v_sales_count_30d, 0);
    v_sales_count_7d  := COALESCE(v_sales_count_7d, 0);

    IF v_sales_count_30d = 0 THEN
      -- Live TS ask floor from badge_editions.low_ask (refreshed every 6h by
      -- badge-sync). Replaces the dead cached_listings_v2 (Flowty shut down).
      SELECT b.low_ask INTO v_ask_floor
      FROM editions e
      JOIN badge_editions b
        ON b.external_id = e.external_id AND b.collection_id = e.collection_id
      WHERE e.id = v_edition_row.edition_id
        AND b.low_ask > 0 AND b.low_ask <= 10000
      ORDER BY b.low_ask ASC
      LIMIT 1;

      IF v_ask_floor IS NOT NULL THEN
        INSERT INTO fmv_snapshots (
          edition_id, collection_id, fmv_usd, floor_price_usd, asp_usd,
          confidence, sales_count_7d, sales_count_30d,
          algo_version, computed_at, collection
        ) VALUES (
          v_edition_row.edition_id, v_collection_id,
          ROUND(v_ask_floor * 0.90, 2), ROUND(v_ask_floor, 2), NULL,
          'ASK_ONLY', 0, 0, 'cold-tail-1.0', NOW(), p_collection_slug
        );
        v_ask_only := v_ask_only + 1;
      ELSE
        -- Historical-sales fallback: price from the 30 most recent priced
        -- sales (any age) at STALE confidence before resorting to NO_DATA.
        SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY h.price_usd),
               MIN(h.price_usd), MAX(h.sold_at), COUNT(*)
        INTO v_hist_median, v_hist_floor, v_hist_last, v_hist_n
        FROM (
          SELECT price_usd, sold_at FROM sales
          WHERE edition_id = v_edition_row.edition_id AND price_usd > 0
          ORDER BY sold_at DESC LIMIT 30
        ) h;

        IF COALESCE(v_hist_n, 0) > 0 THEN
          INSERT INTO fmv_snapshots (
            edition_id, collection_id, fmv_usd, floor_price_usd, asp_usd, asp_without_outliers,
            confidence, sales_count_7d, sales_count_30d, days_since_sale,
            algo_version, computed_at, collection
          ) VALUES (
            v_edition_row.edition_id, v_collection_id,
            ROUND(v_hist_median, 2), ROUND(v_hist_floor, 2), ROUND(v_hist_median, 2), ROUND(v_hist_median, 2),
            'STALE', 0, 0, EXTRACT(DAY FROM NOW() - v_hist_last)::INT,
            'cold-tail-1.0', NOW(), p_collection_slug
          );
          v_stale := v_stale + 1;
        ELSE
          INSERT INTO fmv_snapshots (
            edition_id, collection_id, fmv_usd, floor_price_usd, asp_usd,
            confidence, sales_count_7d, sales_count_30d,
            algo_version, computed_at, collection
          ) VALUES (
            v_edition_row.edition_id, v_collection_id, NULL, NULL, NULL,
            'NO_DATA', 0, 0, 'cold-tail-1.0', NOW(), p_collection_slug
          );
          v_no_data := v_no_data + 1;
        END IF;
      END IF;
    ELSE
      IF v_sales_count_30d >= 5    THEN v_confidence := 'SALES_ONLY';
      ELSIF v_sales_count_30d >= 2 THEN v_confidence := 'LOW';
      ELSE                              v_confidence := 'LOW';
      END IF;

      INSERT INTO fmv_snapshots (
        edition_id, collection_id, fmv_usd, floor_price_usd, asp_usd, asp_without_outliers,
        confidence, sales_count_7d, sales_count_30d, days_since_sale,
        algo_version, computed_at, collection
      ) VALUES (
        v_edition_row.edition_id, v_collection_id,
        ROUND(v_median, 2), ROUND(v_floor, 2), ROUND(v_median, 2), ROUND(v_median, 2),
        v_confidence::fmv_confidence,
        v_sales_count_7d, v_sales_count_30d, v_days_since_sale,
        'cold-tail-1.0', NOW(), p_collection_slug
      );
      v_with_sales := v_with_sales + 1;
    END IF;

    v_processed := v_processed + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'collection_slug', p_collection_slug,
    'processed',       v_processed,
    'with_sales',      v_with_sales,
    'stale',           v_stale,
    'ask_only',        v_ask_only,
    'no_data',         v_no_data,
    'elapsed_ms',      EXTRACT(MILLISECOND FROM NOW() - v_started_at)::INT,
    'started_at',      v_started_at,
    'threshold_days',  7
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.fmv_from_cached_listings(p_collection_id uuid, p_algo_version text DEFAULT 'ask_only_v2'::text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  rows_inserted integer := 0;
  ask_price_ceiling numeric := 5000;
BEGIN
  -- Targeted DELETE: only ASK_ONLY/LOW rows for editions matched by cached_listings without HIGH/MEDIUM
  DELETE FROM fmv_snapshots fs
  WHERE fs.collection_id = p_collection_id
    AND fs.confidence IN ('ASK_ONLY'::fmv_confidence, 'LOW'::fmv_confidence)
    AND fs.edition_id IN (
      SELECT DISTINCT e.id
      FROM cached_listings cl
      JOIN editions e ON e.collection_id = p_collection_id
        AND (
          (cl.moment_id IS NOT NULL AND e.external_id = cl.moment_id)
          OR
          (e.player_name IS NOT NULL AND cl.player_name IS NOT NULL
           AND normalize_name(e.player_name) = normalize_name(cl.player_name)
           AND normalize_name(e.set_name) = normalize_name(cl.set_name))
        )
      WHERE cl.collection_id = p_collection_id
        AND cl.ask_price > 0
        AND NOT EXISTS (
          SELECT 1 FROM fmv_snapshots f2
          WHERE f2.edition_id = e.id
            AND f2.confidence IN ('HIGH'::fmv_confidence, 'MEDIUM'::fmv_confidence)
        )
    );

  -- INSERT new ASK_ONLY rows with sanity ceiling on the fallback path
  INSERT INTO fmv_snapshots (
    edition_id, collection_id, fmv_usd, floor_price_usd, asp_usd,
    confidence, listing_count, algo_version, computed_at,
    liquidity_rating, top_shot_ask, flowty_ask, cross_market_ask
  )
  SELECT
    e.id AS edition_id,
    p_collection_id,
    -- Primary: avg of cl.fmv when present (Flowty's pre-computed FMV is trustworthy)
    -- Fallback: MIN(ask_price) only when cl.fmv is missing AND the ask is below the ceiling
    COALESCE(
      NULLIF(ROUND(AVG(cl.fmv) FILTER (WHERE cl.fmv > 0), 2), 0),
      CASE
        WHEN MIN(cl.ask_price) <= ask_price_ceiling
        THEN ROUND(MIN(cl.ask_price), 2)
        ELSE NULL  -- no FMV row produced — better silence than $1M garbage
      END
    ) AS fmv_usd,
    ROUND(MIN(cl.ask_price), 2) AS floor_price_usd,
    NULL AS wap_usd,
    'ASK_ONLY'::fmv_confidence AS confidence,
    COUNT(cl.id)::int AS listing_count,
    p_algo_version,
    NOW(),
    1 AS liquidity_rating,
    NULL AS top_shot_ask,
    ROUND(MIN(cl.ask_price), 2) AS flowty_ask,
    ROUND(MIN(cl.ask_price), 2) AS cross_market_ask
  FROM cached_listings cl
  JOIN editions e ON e.collection_id = p_collection_id
    AND (
      (cl.moment_id IS NOT NULL AND e.external_id = cl.moment_id)
      OR
      (e.player_name IS NOT NULL AND cl.player_name IS NOT NULL
       AND normalize_name(e.player_name) = normalize_name(cl.player_name)
       AND normalize_name(e.set_name) = normalize_name(cl.set_name))
    )
  WHERE cl.collection_id = p_collection_id
    AND cl.ask_price > 0
    AND NOT EXISTS (
      SELECT 1 FROM fmv_snapshots fs2
      WHERE fs2.edition_id = e.id
        AND fs2.confidence IN ('HIGH'::fmv_confidence, 'MEDIUM'::fmv_confidence)
    )
  GROUP BY e.id
  -- HAVING clause excludes editions where the resulting fmv_usd would be NULL
  HAVING COALESCE(
    NULLIF(ROUND(AVG(cl.fmv) FILTER (WHERE cl.fmv > 0), 2), 0),
    CASE
      WHEN MIN(cl.ask_price) <= ask_price_ceiling
      THEN ROUND(MIN(cl.ask_price), 2)
      ELSE NULL
    END
  ) IS NOT NULL;

  GET DIAGNOSTICS rows_inserted = ROW_COUNT;
  RETURN rows_inserted;
END;
$function$;

CREATE OR REPLACE FUNCTION public.refresh_allday_ask_fmv_from_listings()
 RETURNS TABLE(rescued integer, considered integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_coll        uuid := 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid;
  v_ceiling     numeric := 10000;
  v_today_start timestamptz := date_trunc('day', now());
  v_today_end   timestamptz := date_trunc('day', now()) + interval '1 day';
  v_rescued     int := 0;
  v_considered  int := 0;
  v_started     timestamptz := clock_timestamp();
BEGIN
  -- per-edition floor ask from the live AllDay listings indexer
  DROP TABLE IF EXISTS _ad_ask;
  CREATE TEMP TABLE _ad_ask ON COMMIT DROP AS
  SELECT cl.edition_id, MIN(cl.price_usd) AS low_ask
  FROM cached_listings_v2 cl
  WHERE cl.collection_id = v_coll
    AND cl.price_usd IS NOT NULL AND cl.price_usd > 0 AND cl.price_usd <= v_ceiling
    AND cl.completed_at IS NULL
    AND (cl.expiry_at IS NULL OR cl.expiry_at > now())
  GROUP BY cl.edition_id;

  -- restrict to editions whose LATEST FMV is STALE or NO_DATA — the genuine
  -- rescue set. Never touch HIGH/MEDIUM/LOW/ASK_ONLY/SALES_ONLY (don't clobber a
  -- usable confidence or churn an existing ask floor).
  DROP TABLE IF EXISTS _ad_targets;
  CREATE TEMP TABLE _ad_targets ON COMMIT DROP AS
  SELECT a.edition_id, a.low_ask
  FROM _ad_ask a
  JOIN LATERAL (
    SELECT fs.confidence::text AS conf
    FROM fmv_snapshots fs
    WHERE fs.edition_id = a.edition_id
    ORDER BY fs.computed_at DESC
    LIMIT 1
  ) latest ON true
  WHERE latest.conf IN ('STALE','NO_DATA');

  v_considered := (SELECT count(*) FROM _ad_targets);

  IF v_considered > 0 THEN
    -- FMV write pattern: delete-then-insert for today, never upsert
    DELETE FROM fmv_snapshots fs
    USING _ad_targets t
    WHERE fs.edition_id   = t.edition_id
      AND fs.collection_id = v_coll
      AND fs.computed_at  >= v_today_start
      AND fs.computed_at  <  v_today_end;

    INSERT INTO fmv_snapshots (
      edition_id, collection_id, fmv_usd, floor_price_usd,
      asp_usd, ask_proxy_fmv, cross_market_ask,
      confidence, listing_count, algo_version, computed_at, collection,
      sales_count_7d, sales_count_30d
    )
    SELECT
      t.edition_id, v_coll,
      round(t.low_ask * 0.90, 2), round(t.low_ask, 2),
      round(t.low_ask * 0.90, 2), round(t.low_ask * 0.90, 2), round(t.low_ask, 2),
      'ASK_ONLY'::fmv_confidence, NULL, 'allday-listing-ask-v1', now(), 'nfl_all_day',
      0, 0
    FROM _ad_targets t;
    GET DIAGNOSTICS v_rescued = ROW_COUNT;
  END IF;

  INSERT INTO pipeline_runs (pipeline, ok, started_at, finished_at, extra)
  VALUES ('allday-listing-ask-fmv', true, v_started, clock_timestamp(),
          jsonb_build_object('rescued', v_rescued, 'considered', v_considered));

  RETURN QUERY SELECT v_rescued, v_considered;
END;
$function$;

-- ── 4) Readers (alias asp_usd AS wap_usd at source; output contract unchanged) ─

CREATE OR REPLACE FUNCTION public.get_edition_detail(p_collection_id uuid, p_route_slug text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '8s'
AS $function$
DECLARE
  v_pinnacle_uuid CONSTANT uuid := '7dd9dd11-e8b6-45c4-ac99-71331f959714';
  result jsonb;
BEGIN
  IF p_collection_id = v_pinnacle_uuid THEN
    -- Pinnacle path: pinnacle_editions + per-render FMV via the collapse helper
    -- (PIN-FMV-REKEY Wave 2). floor_usd (catalog floor_ask) carries the live
    -- pinnacle floor; the retired Flowty-era ask/listing/offer fields have no
    -- per-render source and are NULL. fmv_min/fmv_max/render_count expose the
    -- set's per-render spread.
    SELECT jsonb_build_object(
      'id',                pe.id,
      'source',            'pinnacle_editions',
      'collection_id',     v_pinnacle_uuid,
      'collection_slug',   'disney_pinnacle',
      'route_slug',        pe.id,
      'external_id',       pe.external_id,
      'name',              pe.character_name || ' - ' || pe.set_name || ' (' || pe.variant_type || ')',
      'player_name',       pe.character_name,
      'set_name',          pe.set_name,
      'set_slug',          regexp_replace(lower(pe.set_name), '[^a-z0-9]+', '-', 'g'),
      'tier',              pe.variant_type,
      'series_label',      pe.series_year::text,
      'edition_kind',      pe.edition_type,
      'circulation_count', pe.mint_count,
      'is_serialized',     pe.is_serialized,
      'is_chaser',         pe.is_chaser,
      'thumbnail_url',     pe.thumbnail_url,
      'video_url',         NULL::text,
      'team_name',         pe.franchise,
      'first_minted_at',   pe.minting_date,
      'fmv',               CASE
        WHEN fmv.fmv_usd IS NULL THEN NULL
        ELSE jsonb_build_object(
          'fmv_usd',         fmv.fmv_usd,
          'wap_usd',         fmv.wap_usd,
          'floor_usd',       fmv.floor_usd,
          'confidence',      fmv.confidence,
          'computed_at',     fmv.computed_at,
          'sales_count_30d', fmv.sales_count_30d,
          'sales_count_7d',  fmv.sales_count_7d,
          'days_since_sale', fmv.days_since_sale,
          'pinnacle_ask',    fmv.floor_usd,
          'flowty_ask',      NULL::numeric,
          'cross_market_ask',NULL::numeric,
          'listing_count',   NULL::int,
          'offer_count',     NULL::int,
          'fmv_min',         fmv.fmv_min,
          'fmv_max',         fmv.fmv_max,
          'render_count',    fmv.render_count
        )
      END,
      'live_ask', CASE
        WHEN pe.ask_price IS NULL THEN NULL
        ELSE jsonb_build_object(
          'price',          pe.ask_price,
          'source',         pe.ask_source,
          'updated_at',     pe.ask_updated_at
        )
      END
    ) INTO result
    FROM pinnacle_editions pe
    LEFT JOIN LATERAL public.get_pinnacle_edition_fmv_collapsed(pe.id) fmv ON true
    WHERE pe.id = p_route_slug;

  ELSE
    -- Standard path: editions + fmv_snapshots (UUID edition_id)
    SELECT jsonb_build_object(
      'id',                e.id::text,
      'source',            'editions',
      'collection_id',     e.collection_id,
      'collection_slug',   c.slug,
      'route_slug',        COALESCE(e.external_id, e.id::text),
      'external_id',       e.external_id,
      'name',              e.name,
      'player_name',       e.player_name,
      'set_name',          e.set_name,
      'set_slug',          CASE
        WHEN e.set_name IS NULL THEN NULL
        ELSE regexp_replace(lower(e.set_name), '[^a-z0-9]+', '-', 'g')
      END,
      'tier',              e.tier::text,
      'series_label',      e.series::text,
      'series_num',        e.series,
      'edition_kind',      e.edition_kind::text,
      'circulation_count', e.circulation_count,
      'badges',            (
        SELECT coalesce(jsonb_agg(b->>'title'), '[]'::jsonb)
        FROM jsonb_array_elements(public.get_edition_badges_unified(e.id)) AS b
      ),
      'thumbnail_url',     e.thumbnail_url,
      'video_url',         e.video_url,
      'team_name',         e.team_name,
      'first_minted_at',   e.first_minted_at,
      'fmv', CASE
        WHEN fmv.fmv_usd IS NULL THEN NULL
        ELSE jsonb_build_object(
          'fmv_usd',         fmv.fmv_usd,
          'floor_price_usd', fmv.floor_price_usd,
          'wap_usd',         fmv.wap_usd,
          'confidence',      fmv.confidence::text,
          'computed_at',     fmv.computed_at,
          'sales_count_30d', fmv.sales_count_30d,
          'days_since_sale', fmv.days_since_sale,
          'cross_market_ask',fmv.cross_market_ask
        )
      END
    ) INTO result
    FROM editions e
    JOIN collections c ON c.id = e.collection_id
    LEFT JOIN LATERAL (
      SELECT fmv_usd, floor_price_usd, asp_usd AS wap_usd, confidence, computed_at,
             sales_count_30d, days_since_sale, cross_market_ask
      FROM fmv_snapshots
      WHERE edition_id = e.id
      ORDER BY computed_at DESC
      LIMIT 1
    ) fmv ON true
    WHERE e.collection_id = p_collection_id
      AND (e.external_id = p_route_slug OR e.id::text = p_route_slug);
  END IF;

  RETURN result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_edition_fmv_history(p_collection_id uuid, p_route_slug text, p_days integer DEFAULT 30)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '8s'
AS $function$
DECLARE
  v_pinnacle_uuid CONSTANT uuid := '7dd9dd11-e8b6-45c4-ac99-71331f959714';
  v_safe_days     int := LEAST(GREATEST(COALESCE(p_days, 30), 1), 365);
  v_cutoff        timestamptz := NOW() - (v_safe_days || ' days')::interval;
  result jsonb;
BEGIN
  IF p_collection_id = v_pinnacle_uuid THEN
    WITH r AS (
      SELECT pc.render_id
      FROM pinnacle_catalog pc
      WHERE pc.render_id = p_route_slug
         OR pc.edition_id = p_route_slug
      ORDER BY (pc.render_id = p_route_slug) DESC,
               pc.fmv_sales_count_30d DESC NULLS LAST,
               pc.total_minted ASC NULLS LAST
      LIMIT 1
    ),
    daily AS (
      SELECT DISTINCT ON (DATE(h.computed_at))
        DATE(h.computed_at)        AS day,
        h.fmv_usd,
        NULL::numeric              AS wap_usd,
        NULL::numeric              AS floor_usd,
        h.fmv_confidence           AS confidence,
        h.fmv_sales_count_30d      AS sales_count_30d,
        h.computed_at
      FROM r
      JOIN pinnacle_fmv_history h ON h.render_id = r.render_id
      WHERE h.computed_at >= v_cutoff
      ORDER BY DATE(h.computed_at), h.computed_at DESC
    )
    SELECT COALESCE(jsonb_agg(to_jsonb(daily.*) ORDER BY daily.day), '[]'::jsonb)
    INTO result
    FROM daily;
  ELSE
    WITH ed AS (
      SELECT id FROM editions
      WHERE collection_id = p_collection_id
        AND (external_id = p_route_slug OR id::text = p_route_slug)
      LIMIT 1
    ),
    daily AS (
      SELECT DISTINCT ON (DATE(f.computed_at))
        DATE(f.computed_at)            AS day,
        f.fmv_usd,
        f.asp_usd                      AS wap_usd,
        f.floor_price_usd              AS floor_usd,
        f.confidence::text             AS confidence,
        f.sales_count_30d,
        f.computed_at
      FROM ed
      JOIN fmv_snapshots f ON f.edition_id = ed.id
      WHERE f.computed_at >= v_cutoff
      ORDER BY DATE(f.computed_at), f.computed_at DESC
    )
    SELECT COALESCE(jsonb_agg(to_jsonb(daily.*) ORDER BY daily.day), '[]'::jsonb)
    INTO result
    FROM daily;
  END IF;

  RETURN result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_edition_page_data(p_edition_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_edition record;
  v_fmv record;
  v_recent_sales jsonb;
  v_sales_30d_summary jsonb;
  v_collection record;
BEGIN
  SELECT e.id, e.external_id, e.collection_id, e.player_id, e.set_id, e.name,
         e.tier, e.series, e.edition_kind, e.circulation_count, e.badges,
         e.thumbnail_url, e.video_url, e.play_type, e.play_category,
         e.game_date, e.home_team, e.away_team, e.first_minted_at,
         e.set_id_onchain, e.play_id_onchain,
         e.player_name, e.set_name, e.team_name
  INTO v_edition
  FROM editions e WHERE e.id = p_edition_id;

  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT c.id, c.slug, c.name AS collection_name
  INTO v_collection
  FROM collections c WHERE c.id = v_edition.collection_id;

  -- Latest FMV — pull from the partition matching current year automatically
  -- via the parent fmv_snapshots view if it exists, else fall back to 2026 directly
  SELECT fmv_usd, floor_price_usd, asp_usd AS wap_usd, confidence, listing_count,
         sales_count_7d, sales_count_30d, days_since_sale, liquidity_rating,
         computed_at
  INTO v_fmv
  FROM fmv_snapshots_2026
  WHERE edition_id = p_edition_id
  ORDER BY computed_at DESC
  LIMIT 1;

  -- Recent sales (last 20) — UNION across active partitions
  SELECT jsonb_agg(s_row ORDER BY sold_at DESC)
  INTO v_recent_sales
  FROM (
    SELECT jsonb_build_object(
      'serial_number', serial_number,
      'price_usd', price_usd,
      'sold_at', sold_at,
      'marketplace', marketplace,
      'seller_address', seller_address,
      'buyer_address', buyer_address,
      'transaction_hash', transaction_hash
    ) AS s_row, sold_at
    FROM sales_2026
    WHERE edition_id = p_edition_id
    ORDER BY sold_at DESC
    LIMIT 20
  ) sub;

  -- 30-day rollup
  SELECT jsonb_build_object(
    'count', COUNT(*),
    'volume_usd', COALESCE(SUM(price_usd), 0),
    'avg_price_usd', COALESCE(AVG(price_usd), 0)::numeric(10,2),
    'min_price_usd', COALESCE(MIN(price_usd), 0)::numeric(10,2),
    'max_price_usd', COALESCE(MAX(price_usd), 0)::numeric(10,2),
    'unique_buyers', COUNT(DISTINCT buyer_address),
    'unique_sellers', COUNT(DISTINCT seller_address)
  ) INTO v_sales_30d_summary
  FROM sales_2026
  WHERE edition_id = p_edition_id
    AND sold_at > NOW() - INTERVAL '30 days';

  RETURN jsonb_build_object(
    'edition', jsonb_build_object(
      'id', v_edition.id,
      'external_id', v_edition.external_id,
      'name', v_edition.name,
      'tier', v_edition.tier,
      'series', v_edition.series,
      'edition_kind', v_edition.edition_kind,
      'circulation_count', v_edition.circulation_count,
      'badges', v_edition.badges,
      'thumbnail_url', v_edition.thumbnail_url,
      'video_url', v_edition.video_url,
      'play_type', v_edition.play_type,
      'play_category', v_edition.play_category,
      'game_date', v_edition.game_date,
      'home_team', v_edition.home_team,
      'away_team', v_edition.away_team,
      'first_minted_at', v_edition.first_minted_at,
      'set_id_onchain', v_edition.set_id_onchain,
      'play_id_onchain', v_edition.play_id_onchain,
      'player_name', v_edition.player_name,
      'set_name', v_edition.set_name,
      'team_name', v_edition.team_name,
      'player_id', v_edition.player_id,
      'set_id', v_edition.set_id
    ),
    'collection', jsonb_build_object(
      'id', v_collection.id,
      'slug', v_collection.slug,
      'name', v_collection.collection_name
    ),
    'fmv', CASE WHEN v_fmv.fmv_usd IS NOT NULL THEN
      jsonb_build_object(
        'fmv_usd', v_fmv.fmv_usd,
        'floor_price_usd', v_fmv.floor_price_usd,
        'wap_usd', v_fmv.wap_usd,
        'confidence', v_fmv.confidence,
        'listing_count', v_fmv.listing_count,
        'sales_count_7d', v_fmv.sales_count_7d,
        'sales_count_30d', v_fmv.sales_count_30d,
        'days_since_sale', v_fmv.days_since_sale,
        'liquidity_rating', v_fmv.liquidity_rating,
        'computed_at', v_fmv.computed_at
      ) ELSE NULL END,
    'recent_sales', COALESCE(v_recent_sales, '[]'::jsonb),
    'sales_30d_summary', v_sales_30d_summary
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_moment_detail(p_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_resolved      RECORD;
  v_edition       JSONB;
  v_fmv           JSONB;
  v_serial        JSONB := NULL;
  v_serial_fmv    JSONB := NULL;
  v_recent_sales  JSONB;
  v_similar       JSONB;
  v_renders       JSONB := NULL;
  v_price_band    JSONB := NULL;
BEGIN
  SELECT * INTO v_resolved FROM public.resolve_moment_id(p_id) LIMIT 1;

  IF v_resolved IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found', 'input', p_id);
  END IF;

  IF v_resolved.kind = 'pinnacle_edition' THEN
    SELECT jsonb_build_object(
      'id', pe.id, 'external_id', pe.external_id,
      'character_name', pe.character_name, 'franchise', pe.franchise,
      'set_name', pe.set_name, 'variant_type', pe.variant_type,
      'edition_type', pe.edition_type, 'series_year', pe.series_year,
      'printing', pe.printing, 'mint_count', pe.mint_count,
      'is_serialized', pe.is_serialized, 'is_chaser', pe.is_chaser,
      'thumbnail_url', pe.thumbnail_url, 'studio', pe.studio,
      'materials', pe.materials, 'effects', pe.effects,
      'edition_key', pe.edition_key, 'ask_price', pe.ask_price,
      'ask_source', pe.ask_source, 'collection_slug', 'disney_pinnacle'
    )
    INTO v_edition
    FROM pinnacle_editions pe
    WHERE pe.id = v_resolved.pinnacle_edition_id;

    SELECT jsonb_build_object(
      'fmv_usd', f.fmv_usd, 'floor_usd', f.floor_usd,
      'wap_usd', f.wap_usd, 'confidence', f.confidence,
      'sales_count_7d', f.sales_count_7d, 'sales_count_30d', f.sales_count_30d,
      'days_since_sale', f.days_since_sale, 'computed_at', f.computed_at,
      'algo_version', 'pinnacle-render-collapse', 'pinnacle_ask', f.floor_usd,
      'flowty_ask', NULL::numeric,
      'fmv_min', f.fmv_min, 'fmv_max', f.fmv_max, 'render_count', f.render_count
    )
    INTO v_fmv
    FROM public.get_pinnacle_edition_fmv_collapsed(v_resolved.pinnacle_edition_id) f;

    SELECT jsonb_agg(r ORDER BY r.fmv_usd DESC NULLS LAST) INTO v_renders
    FROM (
      SELECT
        pc.render_id,
        pc.character_name,
        pc.set_name,
        pc.variant,
        pc.total_minted,
        pc.fmv_usd,
        pc.fmv_confidence::text AS fmv_confidence,
        pc.floor_ask,
        ('/api/public/pinnacle-image/' || pc.render_id) AS thumbnail_url
      FROM pinnacle_catalog pc
      JOIN pinnacle_editions pe ON pe.id = v_resolved.pinnacle_edition_id
      WHERE pc.legacy_edition_key = pe.edition_key
    ) r;

    SELECT jsonb_agg(s ORDER BY s.sold_at DESC) INTO v_recent_sales
    FROM (
      SELECT
        ps.serial_number,
        ps.sale_price_usd AS price_usd,
        ps.sold_at,
        ps.source AS marketplace,
        ps.buyer_address,
        ps.seller_address
      FROM pinnacle_sales ps
      WHERE ps.edition_id = v_resolved.pinnacle_edition_id
      ORDER BY ps.sold_at DESC LIMIT 10
    ) s;

    SELECT jsonb_agg(sim) INTO v_similar
    FROM (
      SELECT pe2.id, pe2.character_name, pe2.set_name, pe2.variant_type,
        pe2.edition_type AS tier, pe2.series_year AS series, pe2.thumbnail_url, pe2.mint_count AS circulation_count,
        (SELECT fmv_usd FROM public.get_pinnacle_edition_fmv_collapsed(pe2.id)) AS fmv_usd
      FROM pinnacle_editions pe2
      JOIN pinnacle_editions src ON src.id = v_resolved.pinnacle_edition_id
      WHERE pe2.id <> src.id
        AND (pe2.character_name = src.character_name OR pe2.set_name = src.set_name)
      ORDER BY CASE WHEN pe2.character_name = src.character_name THEN 0 ELSE 1 END,
               pe2.minting_date DESC NULLS LAST
      LIMIT 6
    ) sim;

    RETURN jsonb_build_object(
      'ok', true, 'resolved', to_jsonb(v_resolved),
      'edition', v_edition, 'fmv', v_fmv, 'serial_specific', NULL,
      'recent_sales', COALESCE(v_recent_sales, '[]'::jsonb),
      'similar_editions', COALESCE(v_similar, '[]'::jsonb),
      'renders', COALESCE(v_renders, '[]'::jsonb)
    );
  END IF;

  IF v_resolved.edition_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found', 'input', p_id);
  END IF;

  SELECT jsonb_build_object(
    'id', e.id, 'external_id', e.external_id, 'name', e.name,
    'tier', e.tier, 'series', e.series,
    'player_name', e.player_name, 'team_name', e.team_name,
    'set_name', e.set_name, 'set_id_onchain', e.set_id_onchain,
    'play_id_onchain', e.play_id_onchain, 'play_type', e.play_type,
    'play_category', e.play_category, 'game_date', e.game_date,
    'circulation_count', e.circulation_count,
    'thumbnail_url', e.thumbnail_url, 'video_url', e.video_url,
    'collection_slug', v_resolved.collection_slug
  ) INTO v_edition FROM editions e WHERE e.id = v_resolved.edition_id;

  SELECT jsonb_build_object(
    'fmv_usd', fs.fmv_usd, 'floor_price_usd', fs.floor_price_usd,
    'wap_usd', fs.asp_usd, 'confidence', fs.confidence,
    'sales_count_7d', fs.sales_count_7d, 'sales_count_30d', fs.sales_count_30d,
    'days_since_sale', fs.days_since_sale, 'computed_at', fs.computed_at,
    'algo_version', fs.algo_version, 'top_shot_ask', fs.top_shot_ask,
    'flowty_ask', fs.flowty_ask, 'cross_market_ask', fs.cross_market_ask
  )
  INTO v_fmv FROM fmv_snapshots fs
  WHERE fs.edition_id = v_resolved.edition_id
  ORDER BY fs.computed_at DESC LIMIT 1;

  -- Cleaned 30d price band (DISPLAY-ONLY). Mirrors the fmv-recalc dampener for a
  -- high-volume edition: drop < $0.50 dust, then drop > 5x survivor-median
  -- outliers, then report p10/p90 of what's left. Only for LOW/MEDIUM editions
  -- with >= 10 stored 30d sales (the cohort whose bare "LOW" reads as wrong),
  -- and only when >= 5 cleaned sales survive. Consistent by construction with the
  -- confidence label — never contradicts it.
  IF (v_fmv->>'confidence') IN ('LOW', 'MEDIUM')
     AND COALESCE((v_fmv->>'sales_count_30d')::int, 0) >= 10 THEN
    WITH raw AS (
      SELECT s.price_usd::numeric AS p
      FROM sales s
      WHERE s.edition_id = v_resolved.edition_id
        AND s.sold_at >= now() - interval '30 days'
        AND s.price_usd IS NOT NULL
        AND s.price_usd >= 0.50
    ),
    med AS (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY p) AS m FROM raw),
    cleaned AS (
      SELECT r.p FROM raw r CROSS JOIN med
      WHERE med.m IS NULL OR r.p <= med.m * 5
    )
    SELECT CASE WHEN count(*) >= 5 THEN jsonb_build_object(
             'low',  round(percentile_cont(0.10) WITHIN GROUP (ORDER BY p)::numeric, 2),
             'high', round(percentile_cont(0.90) WITHIN GROUP (ORDER BY p)::numeric, 2),
             'n', count(*)
           ) ELSE NULL END
    INTO v_price_band
    FROM cleaned;
  END IF;

  IF v_resolved.kind = 'moment' THEN
    IF v_resolved.moment_id IS NOT NULL THEN
      SELECT jsonb_build_object(
        'serial_number', m.serial_number, 'nft_id', m.nft_id,
        'owner_address', COALESCE(m.owner_address, (
          SELECT w.wallet_address FROM wallet_moments_cache w
          WHERE w.collection_id = m.collection_id AND w.moment_id = m.nft_id
          LIMIT 1
        )),
        'is_listed', m.is_listed,
        'list_price', m.list_price, 'listed_at', m.listed_at,
        'last_sale', COALESCE((
          SELECT jsonb_build_object('price_usd', s.price_usd, 'sold_at', s.sold_at,
                                    'buyer_address', s.buyer_address, 'seller_address', s.seller_address,
                                    'marketplace', s.marketplace)
          FROM sales s WHERE s.moment_id = m.id ORDER BY s.sold_at DESC LIMIT 1
        ), (
          SELECT jsonb_build_object('price_usd', s.price_usd, 'sold_at', s.sold_at,
                                    'buyer_address', s.buyer_address, 'seller_address', s.seller_address,
                                    'marketplace', s.marketplace)
          FROM sales s
          WHERE s.edition_id = v_resolved.edition_id
            AND (s.nft_id = m.nft_id OR (m.serial_number IS NOT NULL AND s.serial_number = m.serial_number))
          ORDER BY s.sold_at DESC LIMIT 1
        ))
      ) INTO v_serial FROM moments m WHERE m.id = v_resolved.moment_id;
    ELSE
      SELECT jsonb_build_object(
        'serial_number', w.serial_number, 'nft_id', w.moment_id,
        'owner_address', w.wallet_address,
        'is_listed', NULL, 'list_price', NULL, 'listed_at', NULL,
        'last_sale', (
          SELECT jsonb_build_object('price_usd', s.price_usd, 'sold_at', s.sold_at,
                                    'buyer_address', s.buyer_address, 'seller_address', s.seller_address,
                                    'marketplace', s.marketplace)
          FROM sales s
          WHERE s.edition_id = v_resolved.edition_id
            AND (s.nft_id = w.moment_id OR (w.serial_number IS NOT NULL AND s.serial_number = w.serial_number))
          ORDER BY s.sold_at DESC LIMIT 1
        )
      ) INTO v_serial
      FROM wallet_moments_cache w
      WHERE w.moment_id = p_id AND w.collection_id = v_resolved.collection_id
      ORDER BY w.last_seen_at DESC NULLS LAST
      LIMIT 1;
    END IF;

    -- Phase 2 serial-adjusted FMV (additive; NULL unless #1/perfect/jersey + HIGH/MEDIUM).
    IF v_serial IS NOT NULL THEN
      v_serial_fmv := public.serial_fmv_estimate(
        v_resolved.collection_id,
        (v_serial->>'serial_number')::int,
        (v_edition->>'circulation_count')::int,
        (v_edition->>'tier'),
        (v_fmv->>'fmv_usd')::numeric,
        (v_fmv->>'confidence'),
        (SELECT e.jersey_number FROM public.editions e WHERE e.id = v_resolved.edition_id AND e.jersey_number > 1)
      );
    END IF;
  END IF;

  -- Recent sales — each row carries "parallel" (printing attribution, Top Shot
  -- only): topshot_moment_subeditions per-NFT, else the edition's own printing.
  WITH recent AS (
    SELECT sa.serial_number, sa.price_usd, sa.sold_at, sa.marketplace,
           sa.buyer_address, sa.seller_address, sa.nft_id
    FROM sales sa WHERE sa.edition_id = v_resolved.edition_id
    ORDER BY sa.sold_at DESC LIMIT 10
  ),
  sub_names AS (
    SELECT DISTINCT ON (subedition_id) subedition_id, subedition_name
    FROM editions
    WHERE v_resolved.collection_slug = 'nba_top_shot'
      AND subedition_id IS NOT NULL AND subedition_name IS NOT NULL
    ORDER BY subedition_id
  ),
  enriched AS (
    SELECT r.serial_number, r.price_usd, r.sold_at, r.marketplace,
           r.buyer_address, r.seller_address,
           CASE WHEN v_resolved.collection_slug = 'nba_top_shot' THEN
             COALESCE(
               CASE WHEN tms.subedition_id > 0
                      THEN COALESCE(sn.subedition_name, 'Parallel #' || tms.subedition_id)
                    WHEN tms.subedition_id = 0 THEN 'Standard'
               END,
               NULLIF(e.subedition_name, ''),
               CASE WHEN e.external_id ~ '^[0-9]+:[0-9]+$' THEN 'Standard' END
             )
           END AS parallel
    FROM recent r
    LEFT JOIN editions e ON e.id = v_resolved.edition_id
    LEFT JOIN topshot_moment_subeditions tms
      ON v_resolved.collection_slug = 'nba_top_shot' AND tms.nft_id = r.nft_id
    LEFT JOIN sub_names sn ON sn.subedition_id = tms.subedition_id
  )
  SELECT jsonb_agg(to_jsonb(s.*) ORDER BY s.sold_at DESC) INTO v_recent_sales
  FROM enriched s;

  SELECT jsonb_agg(sim) INTO v_similar
  FROM (
    SELECT e2.id, e2.player_name, e2.set_name, e2.tier, e2.series, e2.external_id, e2.thumbnail_url, e2.circulation_count,
      (SELECT fmv_usd FROM fmv_snapshots WHERE edition_id = e2.id ORDER BY computed_at DESC LIMIT 1) AS fmv_usd
    FROM editions e2
    JOIN editions src ON src.id = v_resolved.edition_id
    WHERE e2.collection_id = src.collection_id AND e2.id <> src.id
      AND e2.thumbnail_url IS NOT NULL
      AND (e2.player_name = src.player_name OR e2.set_name = src.set_name)
    ORDER BY CASE WHEN e2.player_name = src.player_name THEN 0 ELSE 1 END,
             e2.first_minted_at DESC NULLS LAST LIMIT 6) sim;

  RETURN jsonb_build_object(
    'ok', true, 'resolved', to_jsonb(v_resolved),
    'edition', v_edition, 'fmv', v_fmv, 'serial_specific', v_serial,
    'serial_fmv', v_serial_fmv,
    'price_band_30d', v_price_band,
    'recent_sales', COALESCE(v_recent_sales, '[]'::jsonb),
    'similar_editions', COALESCE(v_similar, '[]'::jsonb)
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.mcp_get_fmv(p_edition_key text, p_collection_slug text, p_serial integer DEFAULT NULL::integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_slug text := lower(trim(p_collection_slug));
  v_collection_id uuid;
  v_edition_id uuid;
  v_snap public.fmv_snapshots%rowtype;
  v_gaps text[] := array[]::text[];
  v_serial_mult numeric;
  v_adjusted numeric;
begin
  if p_edition_key is null or p_edition_key = '' then
    return jsonb_build_object('error', 'edition_key_required',
                              'gaps', to_jsonb(array['edition_key_required']));
  end if;

  select id into v_collection_id from public.collections where slug = v_slug;
  if v_collection_id is null then
    return jsonb_build_object('error', 'unknown_collection_slug',
                              'collection_slug', v_slug,
                              'gaps', to_jsonb(array['unknown_collection_slug_' || coalesce(v_slug,'null')]));
  end if;

  select id into v_edition_id from public.editions
   where collection_id = v_collection_id and external_id = p_edition_key;
  if v_edition_id is null then
    return jsonb_build_object('error', 'edition_not_found',
                              'edition_key', p_edition_key,
                              'collection_slug', v_slug,
                              'gaps', to_jsonb(array['edition_not_found_' || p_edition_key]));
  end if;

  select * into v_snap from public.fmv_snapshots
   where edition_id = v_edition_id
   order by computed_at desc
   limit 1;

  v_gaps := array_append(v_gaps, 'percentile_distribution_not_persisted');
  if v_snap.edition_id is null then
    v_gaps := array_append(v_gaps, 'no_fmv_snapshot_for_edition');
  end if;
  if v_snap.top_shot_ask is null then
    v_gaps := array_append(v_gaps, 'top_shot_ask_unavailable');
  end if;
  if v_snap.flowty_ask is null then
    v_gaps := array_append(v_gaps, 'flowty_ask_unavailable');
  end if;
  if v_snap.liquidity_rating is null then
    v_gaps := array_append(v_gaps, 'liquidity_rating_unavailable');
  end if;
  if v_slug = 'disney_pinnacle' then
    v_gaps := array_append(v_gaps, 'pinnacle_direct_ask_not_yet_in_fmv_snapshots');
  end if;

  if p_serial is not null then
    v_serial_mult := case
      when p_serial = 1 then 12.0
      when p_serial <= 10 then 4.5
      when p_serial <= 23 then 2.8
      else 1.0
    end;
    v_adjusted := coalesce(v_snap.fmv_usd, 0) * v_serial_mult;
  end if;

  return jsonb_build_object(
    'edition_id', v_edition_id,
    'collection_slug', v_slug,
    'external_id', p_edition_key,
    'fmv_usd', v_snap.fmv_usd,
    'wap_usd', v_snap.asp_usd,
    'wap_without_outliers', v_snap.asp_without_outliers,
    'floor_price_usd', v_snap.floor_price_usd,
    'ask_proxy_fmv', v_snap.ask_proxy_fmv,
    'sales_count_7d', v_snap.sales_count_7d,
    'sales_count_30d', v_snap.sales_count_30d,
    'unique_buyers_30d', v_snap.unique_buyers_30d,
    'days_since_sale', v_snap.days_since_sale,
    'top_shot_ask', v_snap.top_shot_ask,
    'flowty_ask', v_snap.flowty_ask,
    'cross_market_ask', v_snap.cross_market_ask,
    'liquidity_rating', v_snap.liquidity_rating,
    'confidence', v_snap.confidence::text,
    'algo_version', v_snap.algo_version,
    'computed_at', v_snap.computed_at,
    'serial', p_serial,
    'serial_mult', v_serial_mult,
    'adjusted_fmv', v_adjusted,
    'gaps', to_jsonb(v_gaps)
  );
end;
$function$;

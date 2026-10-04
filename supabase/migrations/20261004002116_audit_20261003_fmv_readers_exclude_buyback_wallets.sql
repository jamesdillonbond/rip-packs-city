-- audit_20261003_fmv_readers_exclude_buyback_wallets
-- anon-exec: intentional — existing function, ACL unchanged by CREATE OR REPLACE; not anon-executable (verified 2026-10-03) (compute_serial_fmv_jersey_model)
-- anon-exec: intentional — existing function, ACL unchanged by CREATE OR REPLACE; not anon-executable (verified 2026-10-03) (compute_serial_fmv_multipliers)
-- anon-exec: intentional — existing function, ACL unchanged by CREATE OR REPLACE; not anon-executable (verified 2026-10-03) (compute_serial_fmv_power_model)
-- anon-exec: intentional — existing function, ACL unchanged by CREATE OR REPLACE; not anon-executable (verified 2026-10-03) (compute_topshot_parallel_ratio_cells)
-- anon-exec: intentional — existing function, ACL unchanged by CREATE OR REPLACE; not anon-executable (verified 2026-10-03) (compute_ultimate_non_special_fmv)
-- anon-exec: intentional — existing function, ACL unchanged by CREATE OR REPLACE; not anon-executable (verified 2026-10-03) (drain_fmv_cold_tail)
-- anon-exec: intentional — existing function, ACL unchanged by CREATE OR REPLACE; not anon-executable (verified 2026-10-03) (fmv_clamp_disconnected_ask)
-- anon-exec: intentional — existing function, ACL unchanged by CREATE OR REPLACE; not anon-executable (verified 2026-10-03) (fmv_clamp_disconnected_ask_for_editions)
-- anon-exec: intentional — existing function, ACL unchanged by CREATE OR REPLACE; not anon-executable (verified 2026-10-03) (fmv_recalc_historical_candidates)
-- anon-exec: intentional — existing function, ACL unchanged by CREATE OR REPLACE; not anon-executable (verified 2026-10-03) (refresh_topshot_fmv_display_guard)
-- anon-exec: intentional — existing function, ACL unchanged by CREATE OR REPLACE; not anon-executable (verified 2026-10-03) (refresh_topshot_thin_fmv_editions)
-- anon-exec: intentional — existing function, ACL unchanged by CREATE OR REPLACE; not anon-executable (verified 2026-10-03) (upsert_topshot_marketplace_fmv)
-- Every function below is an EXISTING function re-created with only its
-- `sales` reads repointed; CREATE OR REPLACE keeps each one's grants (none is executable by anon or
-- authenticated, verified 2026-10-03). The new view is granted to service_role only.
--
-- 2026-10-03 (known-issues #169; Trevor: "Proceed with all"). FMV and price writers counted Dapper's
-- instant sell-backs as market sales. A sell-back is the issuer buying from a collector at ITS OWN
-- offer, not collector price discovery: measured LIVE (Top Shot, 30 d) 710 of 79,300 sales across
-- 364 editions, 64 of which traded ONLY via sell-backs and carried MEDIUM 39 / LOW 27 FMVs; a raw
-- median moved > 25 % on 104 editions without them. `0xe1f2…` paid 808 distinct prices over 4,987
-- buys in 90 d, i.e. per-edition offers, often ABOVE the collector market, so the bias runs both
-- ways. The FMV backtests (topshot_fmv_backtest, fmv_sales_backtest) already exclude it; this makes
-- the PUBLISHED FMV agree with the yardstick it is measured against.
--
-- WHAT.
--   public.sales_market  = public.sales minus rows whose buyer is in public.buyback_wallets for
--                          that collection (the existing registry, so a wallet added there is
--                          excluded everywhere at once; a NULL buyer is KEPT). security_invoker=on;
--                          SELECT for service_role ONLY, so a reader that could not see the
--                          RLS-protected registry fails LOUDLY instead of silently excluding nothing.
--   Every FROM/JOIN of `sales` in the 12 FMV writers below now reads sales_market. Each body is the
--   live one (prosrc md5 verified against its newest defining migration immediately before this
--   file was generated) with ONLY those references changed — no other edit.
--   Cost: a hash anti-join against a 3-row table; partition pruning and the (edition_id, sold_at)
--   index scans are kept (measured 146 ms / 62 editions, 90 d).
--
-- NOT CHANGED (on purpose): display surfaces that show real transactions (edition charts, recent
-- sales, moment last sale, leaderboards, wallet history) and the candidate selectors.
-- The TS readers (app/api/fmv-recalc, app/api/fmv-backfill) move to sales_market in the same commit.
--
-- APPLIED 2026-10-03 ~5:21 PM PT as version 20261004002116 by an equivalent server-side rewrite: the same
-- FROM/JOIN substitution on each live definition, every result md5-checked against the bodies in THIS
-- file (all 12 equal); any mismatch would have aborted the migration.
--
-- REVERT: re-apply each function's previous definition (the file named next to it below), then
--   DROP VIEW public.sales_market;

CREATE OR REPLACE VIEW public.sales_market WITH (security_invoker = on) AS
SELECT s.*
  FROM public.sales s
 WHERE NOT EXISTS (
         SELECT 1 FROM public.buyback_wallets b
          WHERE b.collection_id = s.collection_id
            AND b.wallet_address = s.buyer_address
       );
COMMENT ON VIEW public.sales_market IS
  'sales minus issuer buy-backs (buyers in buyback_wallets for that collection). Every FMV/price writer reads this, never sales directly (known-issues #169).';
REVOKE ALL ON public.sales_market FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.sales_market TO service_role;

-- fmv_recalc_historical_candidates: 2 sales read(s) repointed. Previous definition: supabase/migrations/20260926032039_audit_20260925_cold_fmv_priced_from_the_latest_market_regime.sql
CREATE OR REPLACE FUNCTION public.fmv_recalc_historical_candidates(p_pinnacle_collection_id uuid, p_stale_after interval DEFAULT '7 days'::interval, p_limit integer DEFAULT 200)
 RETURNS TABLE(edition_id uuid, collection_id uuid, avg_price numeric, min_price numeric, sales_count bigint, latest_sold_at timestamp with time zone, prev_confidence text, low_ask numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET statement_timeout TO '60s'
 SET search_path TO 'public'
AS $function$
  WITH stale AS MATERIALIZED (
    -- The SELECTIVE half, alone. 7,224 of 26,722 survive here today.
    SELECT e.id, e.collection_id, e.external_id, la.confidence::text AS prev_confidence
    FROM editions e
    LEFT JOIN LATERAL (
      SELECT fs.edition_id, fs.confidence, fs.computed_at
      FROM fmv_snapshots fs
      WHERE fs.edition_id = e.id
      ORDER BY fs.computed_at DESC
      LIMIT 1
    ) la ON true
    WHERE (la.edition_id IS NULL
           OR la.confidence = 'NO_DATA'
           OR la.computed_at < now() - p_stale_after)
      AND (e.tier IS NULL OR e.tier <> 'ULTIMATE')
      AND e.collection_id <> p_pinnacle_collection_id
  ),
  cand AS (
    -- The non-selective half, now paid only for survivors -- and the LIMIT stays
    -- AFTER it, so zero-paid-sale editions can never squat the candidate set.
    SELECT s.id, s.collection_id, s.external_id, s.prev_confidence
    FROM stale s
    WHERE EXISTS (
      SELECT 1 FROM public.sales_market sa WHERE sa.edition_id = s.id AND sa.price_usd > 0
    )
    LIMIT p_limit
  )
  SELECT
    c.id,
    c.collection_id,
    -- 2026-09-25: MEDIAN and MIN of the LAST 30 paid sales — the estimator
    -- drain_fmv_cold_tail writes for the same population — never the all-time
    -- mean (see the header). `avg_price` keeps its name for the route.
    -- 2026-09-25 (#140): of those 30, only the ones within 90 days of the
    -- newest sale, never fewer than the 3 most recent (same as the drain).
    h.med::numeric,
    h.mn::numeric,
    h.n,
    h.last_sold,
    c.prev_confidence,
    (SELECT MAX(be.low_ask) FROM badge_editions be
      WHERE be.external_id = c.external_id AND be.collection_id = c.collection_id
        AND be.low_ask > 0 AND be.low_ask <= 10000)
  FROM cand c
  CROSS JOIN LATERAL (
    SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY r.price_usd) AS med,
           MIN(r.price_usd) AS mn,
           COUNT(*)         AS n,
           MAX(r.sold_at)   AS last_sold
    FROM (
      SELECT w.price_usd, w.sold_at
      FROM (
        SELECT l.price_usd, l.sold_at,
               row_number() OVER (ORDER BY l.sold_at DESC) AS rn,
               max(l.sold_at) OVER () AS newest
        FROM (
          SELECT s.price_usd, s.sold_at
          FROM public.sales_market s
          WHERE s.edition_id = c.id AND s.price_usd > 0
          ORDER BY s.sold_at DESC
          LIMIT 30
        ) l
      ) w
      WHERE w.rn <= 3 OR w.sold_at >= w.newest - INTERVAL '90 days'
    ) r
  ) h
  WHERE h.n > 0;
$function$;

-- drain_fmv_cold_tail: 2 sales read(s) repointed. Previous definition: supabase/migrations/20260926032039_audit_20260925_cold_fmv_priced_from_the_latest_market_regime.sql
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
      -- SCOPED 2026-08-26. Without this the aggregate grouped EVERY snapshot
      -- in the table (~1.28M rows, 66,499 buffers, 38.6 s) to answer a question
      -- about one collection's editions. Provably equivalent: 0 of 1,281,003
      -- snapshots carry a collection_id that differs from their edition's.
      -- Served by fmv_snapshots_2026_collection_id_edition_id_computed_at_idx.
      WHERE collection_id = v_collection_id
      GROUP BY edition_id
    ),
    candidates AS (
      SELECT e.id AS edition_id, e.tier, l.last_snapshot AS last_snapshot
      FROM editions e
      LEFT JOIN latest l ON l.edition_id = e.id
      WHERE e.collection_id = v_collection_id
        -- Top-Shot-ONLY phantom guard (scoped 2026-08-17).
        AND NOT (
          v_collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
          AND e.external_id LIKE '%-%'
          AND e.set_id_onchain IS NULL
        )
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
    FROM public.sales_market
    WHERE edition_id = v_edition_row.edition_id
      AND sold_at > NOW() - INTERVAL '30 days'
      AND price_usd > 0;

    v_sales_count_30d := COALESCE(v_sales_count_30d, 0);
    v_sales_count_7d  := COALESCE(v_sales_count_7d, 0);

    IF v_sales_count_30d = 0 THEN
      -- All Day: the live, ghost-filtered floor (20260923 re-point). No live ask => NULL
      -- => falls through to STALE / NO_DATA below, never a price from a gone ask.
      IF v_collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid THEN
        SELECT f.floor_ask INTO v_ask_floor
        FROM allday_edition_floor_ask f
        WHERE f.edition_id = v_edition_row.edition_id
          AND f.floor_ask > 0 AND f.floor_ask <= 10000;
      ELSE
      SELECT b.low_ask INTO v_ask_floor
        FROM editions e
        JOIN badge_editions b
          ON b.external_id = e.external_id AND b.collection_id = e.collection_id
        WHERE e.id = v_edition_row.edition_id
          AND b.low_ask > 0 AND b.low_ask <= 10000
        ORDER BY b.low_ask ASC
        LIMIT 1;
      END IF;

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
        SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY h.price_usd),
               MIN(h.price_usd), MAX(h.sold_at), COUNT(*)
        INTO v_hist_median, v_hist_floor, v_hist_last, v_hist_n
        FROM (
          -- 2026-09-25 (#140): the last 30 paid sales, KEPT only where they sit
          -- within 90 days of the edition's newest sale -- but never fewer than
          -- its 3 most recent. Identical to fmv_recalc_historical_candidates.
          SELECT r.price_usd, r.sold_at
          FROM (
            SELECT l.price_usd, l.sold_at,
                   row_number() OVER (ORDER BY l.sold_at DESC) AS rn,
                   max(l.sold_at) OVER () AS newest
            FROM (
              SELECT price_usd, sold_at FROM public.sales_market
              WHERE edition_id = v_edition_row.edition_id AND price_usd > 0
              ORDER BY sold_at DESC LIMIT 30
            ) l
          ) r
          WHERE r.rn <= 3 OR r.sold_at >= r.newest - INTERVAL '90 days'
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

-- upsert_topshot_marketplace_fmv: 1 sales read(s) repointed. Previous definition: supabase/migrations/20260829013927_audit_20260828_topshot_fmv_populate_prefilters_before_the_sales_scan.sql
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
  FROM public.sales_market s
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

-- refresh_topshot_thin_fmv_editions: 1 sales read(s) repointed. Previous definition: supabase/migrations/20260816010000_audit_20260816_snapshot_thin_fmv_and_edition_offers_backstop.sql
CREATE OR REPLACE FUNCTION public.refresh_topshot_thin_fmv_editions()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '120s'
AS $function$
DECLARE
  v_count integer;
BEGIN
  TRUNCATE public.topshot_thin_fmv_editions;

  INSERT INTO public.topshot_thin_fmv_editions (edition_id, fmv_usd, median_90d, n_90d, computed_at)
  WITH cand AS (
    -- Cheap prefilter using the stored snapshot column: HIGH/MEDIUM editions that are already thin
    -- (sales_count_30d 1..14) -- narrows the median-scan set without touching the sales table.
    SELECT e.id AS edition_id, lf.fmv_usd
    FROM public.editions e
    JOIN LATERAL (
      SELECT fs.confidence, fs.sales_count_30d, fs.fmv_usd
      FROM public.fmv_snapshots fs
      WHERE fs.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
        AND fs.edition_id = e.id
      ORDER BY fs.computed_at DESC
      LIMIT 1
    ) lf ON true
    WHERE e.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
      AND lf.confidence IN ('HIGH','MEDIUM')
      AND lf.fmv_usd > 0
      AND lf.sales_count_30d BETWEEN 1 AND 14
  )
  SELECT c.edition_id, c.fmv_usd, m.median_90d, m.n_90d, now()
  FROM cand c
  JOIN LATERAL (
    SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY s.price_usd)::numeric AS median_90d,
           count(*)::integer AS n_90d
    FROM public.sales_market s
    WHERE s.edition_id = c.edition_id
      AND s.sold_at >= now() - interval '90 days'
      AND s.price_usd > 0
  ) m ON true
  -- Precise definition: thin (<15 sales/90d) AND FMV inflated >1.5x above the 90d median.
  WHERE m.n_90d < 15
    AND m.median_90d > 0
    AND c.fmv_usd > 1.5 * m.median_90d;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$function$;

-- refresh_topshot_fmv_display_guard: 1 sales read(s) repointed. Previous definition: supabase/migrations/20260702141000_audit_20260702_fmv_display_guard_p90_disconnected.sql
CREATE OR REPLACE FUNCTION public.refresh_topshot_fmv_display_guard()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '300s'
AS $function$
DECLARE
  v_count integer;
BEGIN
  TRUNCATE public.topshot_fmv_display_guard;

  INSERT INTO public.topshot_fmv_display_guard
    (external_id, edition_id, fmv_usd, max_sale_90d, median_90d, n_90d,
     is_thin, fmv_exceeds_max, computed_at, p90_90d, fmv_disconnected, clamp_target)
  WITH s90 AS (
    SELECT s.edition_id,
           count(*)::integer AS n_90d,
           max(s.price_usd)::numeric AS max_sale_90d,
           (percentile_cont(0.5) WITHIN GROUP (ORDER BY s.price_usd))::numeric AS median_90d,
           count(*) FILTER (WHERE s.price_usd > 0.10)::integer AS n_real,
           (percentile_cont(0.9) WITHIN GROUP (ORDER BY s.price_usd)
              FILTER (WHERE s.price_usd > 0.10))::numeric AS p90_real,
           (percentile_cont(0.5) WITHIN GROUP (ORDER BY s.price_usd)
              FILTER (WHERE s.price_usd > 0.10))::numeric AS med_real
    FROM public.sales_market s
    WHERE s.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
      AND s.sold_at >= now() - interval '90 days'
      AND s.price_usd > 0
    GROUP BY s.edition_id
  ),
  lf AS (
    SELECT DISTINCT ON (fs.edition_id) fs.edition_id, fs.fmv_usd::numeric AS fmv_usd, fs.confidence
    FROM public.fmv_snapshots fs
    WHERE fs.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
      AND fs.computed_at > now() - interval '10 days'
    ORDER BY fs.edition_id, fs.computed_at DESC
  ),
  scored AS (
    SELECT e.external_id,
           e.id AS edition_id,
           lf.fmv_usd,
           s.max_sale_90d,
           s.median_90d,
           s.n_90d,
           s.p90_real,
           s.med_real,
           (s.n_90d < 15 AND s.median_90d > 0 AND lf.fmv_usd > 1.5 * s.median_90d) AS is_thin,
           (lf.fmv_usd > s.max_sale_90d) AS fmv_exceeds_max,
           (lf.confidence IN ('LOW','ASK_ONLY') AND s.n_real >= 5 AND s.p90_real > 0
             AND ( (COALESCE(e.circulation_count,0) >= 1000 AND lf.fmv_usd > s.p90_real * 3)
                   OR (lf.fmv_usd > s.p90_real * 8) )) AS fmv_disconnected
    FROM public.editions e
    JOIN s90 s ON s.edition_id = e.id
    JOIN lf   ON lf.edition_id = e.id
    WHERE e.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
      AND e.external_id ~ '^[0-9]+:[0-9]+$'
      AND lf.fmv_usd > 0
  )
  SELECT external_id, edition_id, fmv_usd, max_sale_90d, median_90d, n_90d,
         is_thin, fmv_exceeds_max, now(), p90_real, fmv_disconnected,
         CASE WHEN fmv_disconnected
              THEN ROUND(GREATEST(p90_real * 1.5, med_real)::numeric, 2)
              ELSE NULL END AS clamp_target
  FROM scored
  WHERE fmv_exceeds_max OR is_thin OR fmv_disconnected;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$function$;

-- fmv_clamp_disconnected_ask: 2 sales read(s) repointed. Previous definition: supabase/migrations/20260804010000_audit_20260804_fmv_clamp_disconnected_ask_all_collections.sql
CREATE OR REPLACE FUNCTION public.fmv_clamp_disconnected_ask(p_collection_id uuid DEFAULT NULL, p_dry_run boolean DEFAULT false)
 RETURNS TABLE(rows_examined bigint, rows_clamped bigint, dollars_removed numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '120s'
AS $function$
DECLARE
  c_pinnacle uuid := '7dd9dd11-e8b6-45c4-ac99-71331f959714';
  v_ids uuid[];
  v_started timestamptz := clock_timestamp();
  v_examined bigint := 0;
  v_clamped  bigint := 0;
  v_dollars  numeric := 0;
BEGIN
  -- Resolve the collection scope into an ARRAY so every downstream predicate can
  -- stay an index condition. Pinnacle never participates: its FMV is render-keyed
  -- in pinnacle_fmv_history, so a median taken from fmv_snapshots would be wrong.
  IF p_collection_id IS NOT NULL THEN
    IF p_collection_id = c_pinnacle THEN
      RETURN QUERY SELECT 0::bigint, 0::bigint, 0::numeric;
      RETURN;
    END IF;
    v_ids := ARRAY[p_collection_id];
  ELSE
    SELECT array_agg(c.id) INTO v_ids FROM public.collections c WHERE c.id <> c_pinnacle;
  END IF;

  IF v_ids IS NULL OR array_length(v_ids, 1) IS NULL THEN
    RETURN QUERY SELECT 0::bigint, 0::bigint, 0::numeric;
    RETURN;
  END IF;

  IF p_dry_run THEN
    WITH latest AS (
      SELECT DISTINCT ON (fs.edition_id) fs.id, fs.edition_id, fs.fmv_usd, fs.confidence
      FROM public.fmv_snapshots fs
      WHERE fs.collection_id = ANY(v_ids)
      ORDER BY fs.edition_id, fs.computed_at DESC
    ),
    s90 AS (
      SELECT s.edition_id,
        count(*) FILTER (WHERE s.price_usd > 0.10) AS n_real,
        percentile_cont(0.9) WITHIN GROUP (ORDER BY s.price_usd) FILTER (WHERE s.price_usd > 0.10) AS p90,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY s.price_usd) FILTER (WHERE s.price_usd > 0.10) AS med
      FROM public.sales_market s
      WHERE s.collection_id = ANY(v_ids) AND s.sold_at >= now() - interval '90 days'
      GROUP BY s.edition_id
    ),
    targets AS (
      SELECT l.id AS snapshot_id, l.fmv_usd AS old_fmv,
             ROUND(GREATEST(s.p90 * 1.5, s.med)::numeric, 2) AS new_fmv
      FROM latest l
      JOIN s90 s ON s.edition_id = l.edition_id
      JOIN public.editions e ON e.id = l.edition_id
      WHERE l.confidence IN ('LOW','ASK_ONLY')
        AND s.n_real >= 5 AND s.p90 > 0
        AND l.fmv_usd > s.med * 3
        AND l.fmv_usd > s.p90 * 1.5
        AND l.fmv_usd > ROUND(GREATEST(s.p90 * 1.5, s.med)::numeric, 2)
    )
    SELECT count(*), COALESCE(sum(old_fmv - new_fmv), 0) INTO v_examined, v_dollars FROM targets;
    v_clamped := v_examined;
  ELSE
    WITH latest AS (
      SELECT DISTINCT ON (fs.edition_id) fs.id, fs.edition_id, fs.fmv_usd, fs.confidence
      FROM public.fmv_snapshots fs
      WHERE fs.collection_id = ANY(v_ids)
      ORDER BY fs.edition_id, fs.computed_at DESC
    ),
    s90 AS (
      SELECT s.edition_id,
        count(*) FILTER (WHERE s.price_usd > 0.10) AS n_real,
        percentile_cont(0.9) WITHIN GROUP (ORDER BY s.price_usd) FILTER (WHERE s.price_usd > 0.10) AS p90,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY s.price_usd) FILTER (WHERE s.price_usd > 0.10) AS med
      FROM public.sales_market s
      WHERE s.collection_id = ANY(v_ids) AND s.sold_at >= now() - interval '90 days'
      GROUP BY s.edition_id
    ),
    targets AS (
      SELECT l.id AS snapshot_id, l.fmv_usd AS old_fmv,
             ROUND(GREATEST(s.p90 * 1.5, s.med)::numeric, 2) AS new_fmv
      FROM latest l
      JOIN s90 s ON s.edition_id = l.edition_id
      JOIN public.editions e ON e.id = l.edition_id
      WHERE l.confidence IN ('LOW','ASK_ONLY')
        AND s.n_real >= 5 AND s.p90 > 0
        AND l.fmv_usd > s.med * 3
        AND l.fmv_usd > s.p90 * 1.5
        AND l.fmv_usd > ROUND(GREATEST(s.p90 * 1.5, s.med)::numeric, 2)
    ),
    upd AS (
      UPDATE public.fmv_snapshots fs
      SET fmv_usd = t.new_fmv,
          algo_version = CASE WHEN RIGHT(COALESCE(fs.algo_version,''),9) = '_p90clamp'
                              THEN fs.algo_version
                              ELSE COALESCE(fs.algo_version,'') || '_p90clamp' END
      FROM targets t
      WHERE fs.id = t.snapshot_id
      RETURNING (t.old_fmv - t.new_fmv) AS delta
    )
    SELECT count(*), COALESCE(sum(delta), 0) INTO v_clamped, v_dollars FROM upd;
    v_examined := v_clamped;

    IF v_clamped > 0 THEN
      INSERT INTO public.pipeline_runs (pipeline, started_at, finished_at, ok, extra)
      VALUES ('fmv-clamp-disconnected-ask', v_started, clock_timestamp(), true,
              jsonb_build_object('rows_clamped', v_clamped, 'dollars_removed', round(v_dollars, 2),
                                 'scope', COALESCE(p_collection_id::text, 'all')));
    END IF;
  END IF;

  RETURN QUERY SELECT v_examined, v_clamped, round(v_dollars, 2);
END;
$function$;

-- fmv_clamp_disconnected_ask_for_editions: 2 sales read(s) repointed. Previous definition: supabase/migrations/20260830050435_audit_20260830_clamp_for_editions_s90_reads_only_the_low_ask_only_editions.sql
CREATE OR REPLACE FUNCTION public.fmv_clamp_disconnected_ask_for_editions(p_edition_ids uuid[], p_dry_run boolean DEFAULT false)
 RETURNS TABLE(rows_examined bigint, rows_clamped bigint, dollars_removed numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '110s'
AS $function$
DECLARE
  c_pinnacle uuid := '7dd9dd11-e8b6-45c4-ac99-71331f959714';
  v_started timestamptz := clock_timestamp();
  v_examined bigint := 0;
  v_clamped  bigint := 0;
  v_dollars  numeric := 0;
BEGIN
  IF p_edition_ids IS NULL OR cardinality(p_edition_ids) = 0 THEN
    RETURN QUERY SELECT 0::bigint, 0::bigint, 0::numeric;
    RETURN;
  END IF;

  IF p_dry_run THEN
    WITH ids AS (
      SELECT DISTINCT u.id FROM unnest(p_edition_ids) AS u(id)
      JOIN public.editions e ON e.id = u.id AND e.collection_id <> c_pinnacle
    ),
    -- latest = each edition's newest snapshot, kept ONLY when it is a clamp candidate; s90 is
    -- then read for those editions alone (the join below could never use the others).
    latest AS (
      SELECT lf.id, lf.edition_id, lf.fmv_usd, lf.confidence
      FROM ids
      JOIN LATERAL (
        SELECT fs.id, fs.edition_id, fs.fmv_usd, fs.confidence FROM public.fmv_snapshots fs
        WHERE fs.edition_id = ids.id ORDER BY fs.computed_at DESC LIMIT 1
      ) lf ON true
      WHERE lf.confidence IN ('LOW','ASK_ONLY')
    ),
    s90 AS (
      SELECT s.edition_id,
        count(*) FILTER (WHERE s.price_usd > 0.10) AS n_real,
        percentile_cont(0.9) WITHIN GROUP (ORDER BY s.price_usd) FILTER (WHERE s.price_usd > 0.10) AS p90,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY s.price_usd) FILTER (WHERE s.price_usd > 0.10) AS med
      FROM public.sales_market s
      WHERE s.edition_id = ANY(ARRAY(SELECT edition_id FROM latest)) AND s.sold_at >= now() - interval '90 days'
      GROUP BY s.edition_id
    ),
    targets AS (
      SELECT l.id AS snapshot_id, l.fmv_usd AS old_fmv,
             ROUND(GREATEST(s.p90 * 1.5, s.med)::numeric, 2) AS new_fmv
      FROM latest l
      JOIN s90 s ON s.edition_id = l.edition_id
      WHERE s.n_real >= 5 AND s.p90 > 0
        AND l.fmv_usd > s.med * 3
        AND l.fmv_usd > s.p90 * 1.5
        AND l.fmv_usd > ROUND(GREATEST(s.p90 * 1.5, s.med)::numeric, 2)
    )
    SELECT count(*), COALESCE(sum(old_fmv - new_fmv), 0) INTO v_examined, v_dollars FROM targets;
    v_clamped := v_examined;
  ELSE
    WITH ids AS (
      SELECT DISTINCT u.id FROM unnest(p_edition_ids) AS u(id)
      JOIN public.editions e ON e.id = u.id AND e.collection_id <> c_pinnacle
    ),
    latest AS (
      SELECT lf.id, lf.edition_id, lf.fmv_usd, lf.confidence
      FROM ids
      JOIN LATERAL (
        SELECT fs.id, fs.edition_id, fs.fmv_usd, fs.confidence FROM public.fmv_snapshots fs
        WHERE fs.edition_id = ids.id ORDER BY fs.computed_at DESC LIMIT 1
      ) lf ON true
      WHERE lf.confidence IN ('LOW','ASK_ONLY')
    ),
    s90 AS (
      SELECT s.edition_id,
        count(*) FILTER (WHERE s.price_usd > 0.10) AS n_real,
        percentile_cont(0.9) WITHIN GROUP (ORDER BY s.price_usd) FILTER (WHERE s.price_usd > 0.10) AS p90,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY s.price_usd) FILTER (WHERE s.price_usd > 0.10) AS med
      FROM public.sales_market s
      WHERE s.edition_id = ANY(ARRAY(SELECT edition_id FROM latest)) AND s.sold_at >= now() - interval '90 days'
      GROUP BY s.edition_id
    ),
    targets AS (
      SELECT l.id AS snapshot_id, l.fmv_usd AS old_fmv,
             ROUND(GREATEST(s.p90 * 1.5, s.med)::numeric, 2) AS new_fmv
      FROM latest l
      JOIN s90 s ON s.edition_id = l.edition_id
      WHERE s.n_real >= 5 AND s.p90 > 0
        AND l.fmv_usd > s.med * 3
        AND l.fmv_usd > s.p90 * 1.5
        AND l.fmv_usd > ROUND(GREATEST(s.p90 * 1.5, s.med)::numeric, 2)
    ),
    upd AS (
      UPDATE public.fmv_snapshots fs
      SET fmv_usd = t.new_fmv,
          algo_version = CASE WHEN RIGHT(COALESCE(fs.algo_version,''),9) = '_p90clamp'
                              THEN fs.algo_version
                              ELSE COALESCE(fs.algo_version,'') || '_p90clamp' END
      FROM targets t
      WHERE fs.id = t.snapshot_id
      RETURNING (t.old_fmv - t.new_fmv) AS delta
    )
    SELECT count(*), COALESCE(sum(delta), 0) INTO v_clamped, v_dollars FROM upd;
    v_examined := v_clamped;

    IF v_clamped > 0 THEN
      INSERT INTO public.pipeline_runs (pipeline, started_at, finished_at, ok, extra)
      VALUES ('fmv-clamp-disconnected-ask', v_started, clock_timestamp(), true,
              jsonb_build_object('rows_clamped', v_clamped, 'dollars_removed', round(v_dollars, 2),
                                 'scope', 'editions:' || cardinality(p_edition_ids)));
    END IF;
  END IF;

  RETURN QUERY SELECT v_examined, v_clamped, round(v_dollars, 2);
END;
$function$;

-- compute_topshot_parallel_ratio_cells: 2 sales read(s) repointed. Previous definition: supabase/migrations/20260930133000_audit_20260930_edition_fmv_estimates_from_parallel_ratios.sql
CREATE OR REPLACE FUNCTION public.compute_topshot_parallel_ratio_cells()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_coll       constant uuid    := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_min_n      constant int     := 30;
  v_max_err    constant float8  := ln(1.5::float8);
  v_started    timestamptz := clock_timestamp();
  v_stamp      timestamptz := clock_timestamp();
  v_obs        int;            -- NULL = not measured (the read failed)
  v_cells      int;            -- NULL = not measured
  v_written    int := 0;       -- rows that LANDED; a rolled-back write is 0, truly
  v_eligible   int;
  v_deleted    int;            -- NULL = the delete did not run
  v_err        text;
  v_delete_err text;
  v_ok         boolean;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('compute_topshot_parallel_ratio_cells')::bigint) THEN
    RETURN jsonb_build_object('skipped', 'concurrent');
  END IF;

  BEGIN
    WITH par AS (
      SELECT e.id AS pid, e.subedition_name AS sub, e.tier::text AS tier, be.id AS bid
      FROM editions e
      JOIN editions be
        ON be.collection_id = e.collection_id
       AND be.external_id = split_part(e.external_id, '::', 1)
      WHERE e.collection_id = v_coll
        AND e.external_id ~ '^[0-9]+:[0-9]+::[0-9]+$'
        AND e.subedition_name IS NOT NULL
        AND e.tier IS NOT NULL
    ), pm AS (
      SELECT p.pid, p.sub, p.tier, p.bid, date_trunc('month', s.sold_at) AS m,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY s.price_usd::float8) AS pmed
      FROM par p
      JOIN public.sales_market s ON s.edition_id = p.pid
      WHERE s.sold_at >= now() - interval '365 days'
        AND s.price_usd > 0
      GROUP BY 1, 2, 3, 4, 5
    ), bm AS (
      SELECT s.edition_id AS bid, date_trunc('month', s.sold_at) AS m,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY s.price_usd::float8) AS bmed,
             count(*) AS bn
      FROM public.sales_market s
      WHERE s.edition_id IN (SELECT DISTINCT bid FROM pm)
        AND s.sold_at >= now() - interval '365 days'
        AND s.price_usd > 0
      GROUP BY 1, 2
    ), obs AS (
      SELECT pm.pid, pm.sub, pm.tier, pm.pmed / bm.bmed AS ratio
      FROM pm
      JOIN bm ON bm.bid = pm.bid AND bm.m = pm.m
      WHERE bm.bn >= 3 AND bm.bmed > 0
    ), per_ed AS (
      SELECT pid, sub, tier, percentile_cont(0.5) WITHIN GROUP (ORDER BY ratio) AS r
      FROM obs
      GROUP BY 1, 2, 3
    ), ranked AS (
      SELECT pe.*,
             (row_number() OVER (PARTITION BY sub, tier ORDER BY r, pid))::int AS k,
             (count(*)     OVER (PARTITION BY sub, tier))::int                 AS n
      FROM per_ed pe
    ), arr AS (
      SELECT sub, tier, array_agg(r ORDER BY r, pid) AS a
      FROM per_ed
      GROUP BY 1, 2
    ), loo AS (
      -- The median of the cell WITHOUT this edition, read off the sorted array with
      -- the edition's own slot (k) skipped: remaining slot j is a[j] if j < k, else
      -- a[j+1]. Same definition as percentile_cont(0.5) on the n-1 survivors.
      SELECT rk.sub, rk.tier, rk.r AS actual,
             CASE
               WHEN rk.n < 2 THEN NULL
               WHEN (rk.n - 1) % 2 = 1 THEN
                 CASE WHEN (rk.n / 2) < rk.k THEN arr.a[rk.n / 2] ELSE arr.a[rk.n / 2 + 1] END
               ELSE (
                 (CASE WHEN ((rk.n - 1) / 2) < rk.k THEN arr.a[(rk.n - 1) / 2] ELSE arr.a[(rk.n - 1) / 2 + 1] END)
               + (CASE WHEN ((rk.n - 1) / 2 + 1) < rk.k THEN arr.a[(rk.n - 1) / 2 + 1] ELSE arr.a[(rk.n - 1) / 2 + 2] END)
               ) / 2
             END AS pred
      FROM ranked rk
      JOIN arr ON arr.sub = rk.sub AND arr.tier = rk.tier
    ), err AS (
      SELECT sub, tier,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY abs(ln(pred / actual))) AS e
      FROM loo
      WHERE pred > 0 AND actual > 0
      GROUP BY 1, 2
    ), cells AS (
      SELECT pe.sub, pe.tier, count(*)::int AS n,
             percentile_cont(0.5)  WITHIN GROUP (ORDER BY pe.r) AS med,
             percentile_cont(0.25) WITHIN GROUP (ORDER BY pe.r) AS p25,
             percentile_cont(0.75) WITHIN GROUP (ORDER BY pe.r) AS p75,
             max(err.e) AS e
      FROM per_ed pe
      LEFT JOIN err ON err.sub = pe.sub AND err.tier = pe.tier
      GROUP BY 1, 2
    ), up AS (
      INSERT INTO topshot_parallel_ratio_cells AS t (
        subedition_name, tier, n_editions, median_ratio, p25_ratio, p75_ratio,
        loo_median_abs_log_err, eligible, computed_at)
      SELECT c.sub, c.tier, c.n,
             round(c.med::numeric, 4), round(c.p25::numeric, 4), round(c.p75::numeric, 4),
             round(c.e::numeric, 4),
             (c.n >= v_min_n AND c.e IS NOT NULL AND c.e <= v_max_err),
             v_stamp
      FROM cells c
      ON CONFLICT (subedition_name, tier) DO UPDATE SET
        n_editions             = EXCLUDED.n_editions,
        median_ratio           = EXCLUDED.median_ratio,
        p25_ratio              = EXCLUDED.p25_ratio,
        p75_ratio              = EXCLUDED.p75_ratio,
        loo_median_abs_log_err = EXCLUDED.loo_median_abs_log_err,
        eligible               = EXCLUDED.eligible,
        computed_at            = EXCLUDED.computed_at
      RETURNING t.eligible
    )
    SELECT (SELECT count(*) FROM obs), (SELECT count(*) FROM cells),
           count(*), count(*) FILTER (WHERE up.eligible)
      INTO v_obs, v_cells, v_written, v_eligible
      FROM up;
  EXCEPTION WHEN query_canceled OR OTHERS THEN
    v_err := left(SQLERRM, 300);
  END;

  IF v_err IS NULL AND v_written = 0 THEN
    -- Zero cells is a broken read, never "no parallel carries a premium": keep the
    -- previous set rather than let the delete below empty the table.
    v_err := 'no cells computed; previous cell set kept';
  END IF;

  IF v_err IS NULL THEN
    BEGIN
      DELETE FROM topshot_parallel_ratio_cells WHERE computed_at IS DISTINCT FROM v_stamp;
      GET DIAGNOSTICS v_deleted = ROW_COUNT;
    EXCEPTION WHEN query_canceled OR OTHERS THEN
      v_delete_err := left(SQLERRM, 300);
    END;
  END IF;

  v_ok := v_err IS NULL AND v_delete_err IS NULL AND v_written = v_cells;

  PERFORM public.log_pipeline_run(
    'topshot-parallel-ratio-cells', v_started, v_cells, v_written, 0,
    v_ok, coalesce(v_err, v_delete_err), 'nba_top_shot', NULL, NULL,
    jsonb_build_object('observations', v_obs, 'cells', v_cells, 'cells_written', v_written,
                       'write_error', v_err, 'cells_eligible', v_eligible,
                       'cells_deleted', v_deleted, 'delete_error', v_delete_err,
                       'duration_ms', (extract(epoch FROM clock_timestamp() - v_started) * 1000)::int));

  RETURN jsonb_build_object('ok', v_ok, 'observations', v_obs, 'cells', v_cells,
                            'cells_written', v_written, 'write_error', v_err,
                            'cells_eligible', v_eligible, 'cells_deleted', v_deleted,
                            'delete_error', v_delete_err);
END
$function$;

-- compute_ultimate_non_special_fmv: 1 sales read(s) repointed. Previous definition: supabase/migrations/20260801231600_audit_20260801_snapshot_compute_ultimate_non_special_fmv.sql
CREATE OR REPLACE FUNCTION public.compute_ultimate_non_special_fmv(p_edition_id uuid)
 RETURNS TABLE(edition_id uuid, collection_id uuid, collection_slug text, circulation integer, jersey_number integer, special_serials integer[], filter_skipped boolean, last_non_special_sale_price numeric, last_non_special_sale_at timestamp with time zone, days_since_sale integer, lowest_non_special_ask numeric, fmv_usd numeric, source text, confidence text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_circ int;
  v_player_id uuid;
  v_jersey int;
  v_collection_id uuid;
  v_collection_slug text;
  v_player_name text;
  v_set_name text;
  v_specials int[];
  v_skip boolean;
  v_last_sale numeric;
  v_last_at timestamptz;
  v_days int;
  v_low_ask numeric;
  v_fmv numeric;
  v_source text;
  v_conf text;
BEGIN
  SELECT e.collection_id, c.slug, e.circulation_count, e.player_id, e.player_name, e.set_name
    INTO v_collection_id, v_collection_slug, v_circ, v_player_id, v_player_name, v_set_name
  FROM editions e
  JOIN collections c ON c.id = e.collection_id
  WHERE e.id = p_edition_id AND e.tier = 'ULTIMATE';

  IF NOT FOUND THEN RETURN; END IF;

  v_skip := (v_circ IS NULL OR v_circ <= 1);
  v_specials := get_ultimate_special_serials(p_edition_id);

  IF v_player_id IS NOT NULL THEN
    SELECT p.jersey_number INTO v_jersey FROM players p WHERE p.id = v_player_id;
  END IF;

  SELECT s.price_usd, s.sold_at
    INTO v_last_sale, v_last_at
  FROM public.sales_market s
  WHERE s.edition_id = p_edition_id
    AND s.price_usd > 0
    AND (v_skip OR NOT (s.serial_number = ANY(v_specials)))
  ORDER BY s.sold_at DESC
  LIMIT 1;

  IF v_last_at IS NOT NULL THEN
    v_days := EXTRACT(DAY FROM (now() - v_last_at))::int;
  END IF;

  IF v_player_name IS NOT NULL AND v_set_name IS NOT NULL THEN
    SELECT MIN(cl.ask_price)
      INTO v_low_ask
    FROM cached_listings cl
    WHERE cl.collection_id = v_collection_id
      AND cl.tier = 'ULTIMATE'
      AND cl.player_name = v_player_name
      AND cl.set_name = v_set_name
      AND cl.ask_price > 0
      AND (v_skip OR NOT (cl.serial_number = ANY(v_specials)));
  END IF;

  IF v_last_sale IS NOT NULL AND v_low_ask IS NOT NULL THEN
    v_fmv := LEAST(v_last_sale, v_low_ask);
    v_source := 'min_sale_ask';
    v_conf := 'LOW';
  ELSIF v_last_sale IS NOT NULL THEN
    v_fmv := v_last_sale;
    v_source := 'sale_only';
    v_conf := 'SALES_ONLY';
  ELSIF v_low_ask IS NOT NULL THEN
    v_fmv := v_low_ask;
    v_source := 'ask_only';
    v_conf := 'ASK_ONLY';
  ELSE
    v_fmv := NULL;
    v_source := 'no_data';
    v_conf := 'NO_DATA';
  END IF;

  RETURN QUERY SELECT
    p_edition_id, v_collection_id, v_collection_slug, v_circ, v_jersey, v_specials, v_skip,
    v_last_sale, v_last_at, v_days, v_low_ask, v_fmv, v_source, v_conf;
END;
$function$;

-- compute_serial_fmv_jersey_model: 1 sales read(s) repointed. Previous definition: supabase/migrations/20260801231800_audit_20260801_snapshot_compute_serial_fmv_jersey_model.sql
CREATE OR REPLACE FUNCTION public.compute_serial_fmv_jersey_model(p_collection_id uuid DEFAULT '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid, p_lookback_days integer DEFAULT 180, p_min_sample integer DEFAULT 40, p_min_r numeric DEFAULT 0.35)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '600s'
AS $function$
DECLARE v_rows integer;
BEGIN
  DELETE FROM public.serial_fmv_jersey_model WHERE collection_id = p_collection_id;
  WITH latest_fmv AS (
    SELECT DISTINCT ON (fs.edition_id) fs.edition_id, fs.fmv_usd, fs.confidence::text AS confidence
    FROM public.fmv_snapshots fs
    WHERE fs.collection_id = p_collection_id AND fs.computed_at > now() - interval '21 days'
    ORDER BY fs.edition_id, fs.computed_at DESC
  ),
  d AS (
    SELECT s.price_usd, lf.fmv_usd, e.tier::text AS tier
    FROM public.sales_market s
    JOIN public.editions e ON e.id = s.edition_id
    JOIN latest_fmv lf ON lf.edition_id = s.edition_id
    WHERE s.collection_id = p_collection_id
      AND s.sold_at > now() - make_interval(days => p_lookback_days)
      AND s.price_usd > 0 AND e.circulation_count > 0 AND lf.fmv_usd > 0
      AND lf.confidence IN ('HIGH','MEDIUM')
      AND e.jersey_number IS NOT NULL AND e.jersey_number > 1
      AND s.serial_number = e.jersey_number
      AND s.serial_number <> 1
      AND s.serial_number <> e.circulation_count
  ),
  fits AS (
    SELECT d.tier, exp(regr_intercept(ln(price_usd), ln(fmv_usd))) AS k, regr_slope(ln(price_usd), ln(fmv_usd)) AS beta,
      count(*)::int AS n, corr(ln(price_usd), ln(fmv_usd)) AS r, min(fmv_usd) AS fmv_min, max(fmv_usd) AS fmv_max
    FROM d WHERE d.tier IS NOT NULL GROUP BY d.tier
    UNION ALL
    SELECT 'ALL', exp(regr_intercept(ln(price_usd), ln(fmv_usd))), regr_slope(ln(price_usd), ln(fmv_usd)),
      count(*)::int, corr(ln(price_usd), ln(fmv_usd)), min(fmv_usd), max(fmv_usd)
    FROM d
  )
  INSERT INTO public.serial_fmv_jersey_model (collection_id, tier, k, beta, sample_size, r, fmv_min, fmv_max, is_reliable, computed_at)
  SELECT p_collection_id, f.tier, round(f.k::numeric,4), round(f.beta::numeric,4), f.n, round(f.r::numeric,3),
    round(f.fmv_min::numeric,2), round(f.fmv_max::numeric,2),
    (f.n >= p_min_sample AND f.r >= p_min_r AND f.beta > 0.15 AND f.beta < 1.0), now()
  FROM fits f WHERE f.k IS NOT NULL AND f.beta IS NOT NULL;
  GET DIAGNOSTICS v_rows = ROW_COUNT; RETURN v_rows;
END;
$function$;

-- compute_serial_fmv_multipliers: 1 sales read(s) repointed. Previous definition: supabase/migrations/20260801231500_audit_20260801_snapshot_compute_serial_fmv_multipliers.sql
CREATE OR REPLACE FUNCTION public.compute_serial_fmv_multipliers(p_collection_id uuid DEFAULT '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid, p_min_sample integer DEFAULT 8, p_cap numeric DEFAULT 60.0, p_lookback_days integer DEFAULT 180)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '600s'
AS $function$
DECLARE v_rows integer;
BEGIN
  DELETE FROM public.serial_fmv_multipliers WHERE collection_id = p_collection_id;
  WITH ed_sales AS (
    SELECT s.edition_id, s.serial_number, s.price_usd, coalesce(e.tier::text,'UNKNOWN') AS tier, e.circulation_count AS circ
    FROM public.sales_market s JOIN public.editions e ON e.id = s.edition_id
    WHERE s.collection_id = p_collection_id
      AND s.sold_at > now() - make_interval(days => p_lookback_days)
      AND s.price_usd > 0 AND s.serial_number IS NOT NULL AND e.circulation_count > 0
  ),
  ed_median AS (
    SELECT edition_id, percentile_cont(0.5) WITHIN GROUP (ORDER BY price_usd) AS med
    FROM ed_sales GROUP BY edition_id HAVING count(*) >= 10
  ),
  premiums AS (
    SELECT es.price_usd / em.med AS premium,
      CASE WHEN es.serial_number=1 THEN 'first' WHEN es.serial_number=es.circ THEN 'perfect'
           WHEN es.serial_number BETWEEN 2 AND 10 THEN 'low' ELSE 'normal' END AS bucket,
      es.tier,
      CASE WHEN es.circ<100 THEN 'ultra' WHEN es.circ<500 THEN 'low' WHEN es.circ<2500 THEN 'mid'
           WHEN es.circ<10000 THEN 'high' ELSE 'mass' END AS circ_band
    FROM ed_sales es JOIN ed_median em ON em.edition_id = es.edition_id
  ),
  ins AS (
    INSERT INTO public.serial_fmv_multipliers
      (collection_id, serial_bucket, tier, circ_band, sample_size, median_premium, multiplier, is_reliable, computed_at)
    SELECT p_collection_id, bucket, tier, circ_band, count(*),
      round(percentile_cont(0.5) WITHIN GROUP (ORDER BY premium)::numeric,4),
      LEAST(GREATEST(percentile_cont(0.5) WITHIN GROUP (ORDER BY premium),1.0),p_cap),
      count(*) >= p_min_sample, now()
    FROM premiums GROUP BY bucket, tier, circ_band
    UNION ALL
    SELECT p_collection_id, bucket, 'ALL','ALL', count(*),
      round(percentile_cont(0.5) WITHIN GROUP (ORDER BY premium)::numeric,4),
      LEAST(GREATEST(percentile_cont(0.5) WITHIN GROUP (ORDER BY premium),1.0),p_cap),
      count(*) >= p_min_sample, now()
    FROM premiums GROUP BY bucket
    RETURNING 1
  )
  SELECT count(*) INTO v_rows FROM ins;
  RETURN v_rows;
END;
$function$;

-- compute_serial_fmv_power_model: 1 sales read(s) repointed. Previous definition: supabase/migrations/20260801231700_audit_20260801_snapshot_compute_serial_fmv_power_model.sql
CREATE OR REPLACE FUNCTION public.compute_serial_fmv_power_model(p_collection_id uuid DEFAULT '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid, p_lookback_days integer DEFAULT 180, p_min_sample integer DEFAULT 40, p_min_r numeric DEFAULT 0.35)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '600s'
AS $function$
DECLARE v_rows integer;
BEGIN
  DELETE FROM public.serial_fmv_power_model WHERE collection_id = p_collection_id;
  WITH latest_fmv AS (
    SELECT DISTINCT ON (fs.edition_id) fs.edition_id, fs.fmv_usd, fs.confidence::text AS confidence
    FROM public.fmv_snapshots fs
    WHERE fs.collection_id = p_collection_id
      AND fs.computed_at > now() - interval '21 days'
    ORDER BY fs.edition_id, fs.computed_at DESC
  ),
  d AS (
    SELECT s.price_usd, lf.fmv_usd,
      CASE WHEN s.serial_number = 1 THEN 'first'
           WHEN s.serial_number = e.circulation_count THEN 'perfect' END AS bucket,
      e.tier::text AS tier
    FROM public.sales_market s
    JOIN public.editions e ON e.id = s.edition_id
    JOIN latest_fmv lf ON lf.edition_id = s.edition_id
    WHERE s.collection_id = p_collection_id
      AND s.sold_at > now() - make_interval(days => p_lookback_days)
      AND s.price_usd > 0 AND e.circulation_count > 0 AND lf.fmv_usd > 0
      AND lf.confidence IN ('HIGH','MEDIUM')
      AND (s.serial_number = 1 OR s.serial_number = e.circulation_count)
  ),
  fits AS (
    SELECT 'first'::text AS serial_bucket, d.tier,
      exp(regr_intercept(ln(price_usd), ln(fmv_usd))) AS k,
      regr_slope(ln(price_usd), ln(fmv_usd)) AS beta,
      count(*)::int AS n, corr(ln(price_usd), ln(fmv_usd)) AS r,
      min(fmv_usd) AS fmv_min, max(fmv_usd) AS fmv_max
    FROM d WHERE d.bucket = 'first' AND d.tier IS NOT NULL GROUP BY d.tier
    UNION ALL
    SELECT 'perfect', 'ALL',
      exp(regr_intercept(ln(price_usd), ln(fmv_usd))),
      regr_slope(ln(price_usd), ln(fmv_usd)),
      count(*)::int, corr(ln(price_usd), ln(fmv_usd)),
      min(fmv_usd), max(fmv_usd)
    FROM d WHERE d.bucket = 'perfect'
  )
  INSERT INTO public.serial_fmv_power_model
    (collection_id, serial_bucket, tier, k, beta, sample_size, r, fmv_min, fmv_max, is_reliable, computed_at)
  SELECT p_collection_id, f.serial_bucket, f.tier,
    round(f.k::numeric,4), round(f.beta::numeric,4), f.n, round(f.r::numeric,3),
    round(f.fmv_min::numeric,2), round(f.fmv_max::numeric,2),
    (f.n >= p_min_sample AND f.r >= p_min_r AND f.beta > 0.15 AND f.beta < 1.25),
    now()
  FROM fits f WHERE f.k IS NOT NULL AND f.beta IS NOT NULL;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows;
END;
$function$;

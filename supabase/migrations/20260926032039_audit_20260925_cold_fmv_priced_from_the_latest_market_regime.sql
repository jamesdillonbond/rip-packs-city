-- 2026-09-25 (PT) — #140: a dormant edition's FMV is priced from its LATEST
-- market regime, not from a sale count that reaches back years.
--
-- WHY. Both writers of the cold population (no sale in 30 days) —
-- fmv_recalc_historical_candidates (fmv-recalc Step 5b, algo 1.7.0, labels
-- SALES_ONLY / STALE) and drain_fmv_cold_tail (cold-tail-1.0, STALE) — priced
-- at the median of the edition's last 30 paid sales. On a thin edition those 30
-- can span two years: Cowboys Banner Year RARE (All Day 2202) has 24 of its last
-- 30 sales from 2024 at $25-$40 and its 2026 prints at $1-$7, so it published
-- $38-$47 against a market of ~$1.64. Measured 2026-09-25 ~8:50 PM PT over the
-- STALE/SALES_ONLY rows of both writers, editions with >=3 sales in 180 days
-- whose FMV sat above 3x that recent median: All Day 38 of 77, UFC 1 of 8,
-- Golazos 2 of 8, Top Shot 1 of 85.
--
-- WHAT. Same last-30 read (same index path, same cost), then keep only sales
-- within 90 days of the edition's NEWEST sale, never fewer than its 3 most
-- recent. Anchoring on the newest sale (not now()) keeps a dormant edition
-- priced from the last market it had; the 3-sale floor stops one print from
-- setting the price. Simulated before apply on the same population: >3x
-- offenders All Day 38 -> 0, Golazos 2 -> 0, UFC 1 -> 0, Top Shot 1 -> 0, none
-- pushed below 1/3 of the recent median; a pure 90-day window WITHOUT the floor
-- left most windows at one sale ($1 -> $205 on Golazos) and was rejected. The
-- independent control, today's live floor ask: median |ln(fmv/ask)| Golazos
-- 0.64 -> 0.41, All Day 1.64 -> 1.32; Golazos editions priced ABOVE their
-- buy-it-now 194 -> 75 of 307. Both functions change IDENTICALLY so the two
-- writers still agree (the weekly flip 20260925135620 closed stays closed).
-- Bodies are the live prosrc (md5-verified) with only the sample changed.
--
-- Revert: re-apply the bodies in 20260925135620 (candidates) and the previous
-- drain_fmv_cold_tail body (its hist subquery was `ORDER BY sold_at DESC LIMIT
-- 30` with no window).

-- anon-exec: intentional — both functions stay service_role-only; CREATE OR REPLACE keeps their ACL (drain_fmv_cold_tail, fmv_recalc_historical_candidates)

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
      SELECT 1 FROM sales sa WHERE sa.edition_id = s.id AND sa.price_usd > 0
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
          FROM sales s
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
    FROM sales
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
              SELECT price_usd, sold_at FROM sales
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

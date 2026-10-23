-- audit_20261022_ask_only_fmv_restamped_when_the_ask_falls_below_it
--
-- 2026-10-22 (PT, Claude Code cloud). Found while re-reading the Series 2026-27 launch checks.
--
-- WHAT. A Top Shot ASK_ONLY FMV is 0.90 x the cheapest ask on the day it was written. For an edition
-- with no 30-day sale nothing re-priced it for 7 days: the fmv-recalc main sweep walks editions WITH
-- sales, its Step 5 backfill prices editions with NO snapshot, and drain_fmv_cold_tail waits for a
-- snapshot older than 7 days. So when the ask FELL, the published FMV sat ABOVE the cheapest listing
-- for up to a week. Read 2026-10-22 ~8:55 PM PT from fmv_snapshots directly: 75 of 3,057 Top Shot
-- ASK_ONLY editions (45 base, 30 parallels) above today's badge_editions.low_ask, 48 by > 10 %, median
-- age ~100 h, every one of those asks refreshed < 24 h ago. Example: 284:9319 (LeBron, Fresh Threads,
-- Series 2026-27) FMV $405 (0.90 x a $450 ask, 10-21 5:08 PM PT) vs a $350 ask now.
--
-- FIX. drain_fmv_cold_tail gains a second candidate arm, Top Shot only: newest snapshot ASK_ONLY, its
-- FMV above today's ask, no 30-day sale. Those rows run through the drain's existing ask branch (0.90 x
-- today's ask) and sort first. Disjoint from the 7-day arm by construction. edition_fmv_current only
-- narrows the scan (it lags fmv_snapshots: 1,831 Top Shot rows behind at read time); the LATERAL
-- re-reads the real newest snapshot, so a lagging row cannot clobber a newer price. An ask-fell row
-- whose ask vanished, or which sold, between selection and the loop is SKIPPED, never demoted.
-- New return key: ask_fell_restamped. Nothing else in the body changes.
--
-- WHY TOP SHOT ONLY. It is the measured population, and All Day's ask branch reads
-- allday_edition_floor_ask, not badge_editions, so the arm's comparison would be against the wrong ask.
-- Parallels are included: badge_editions holds a per-parallel low_ask (45 of 4,289 equal their base's).
--
-- COST (EXPLAIN ANALYZE of the arm alone, 2026-10-22): 74 rows, 97 ms, 36,094 buffers (all hit).
--
-- BASE: 20261004030511_audit_20261003_run_durations_no_longer_wrap_at_60_seconds.sql — live prosrc md5
-- 54b87a10fa45a1c012be6ea19c471950 re-read 2026-10-22 ~8:58 PM PT, equal to that file's stamped md5.
--
-- anon-exec: unchanged (revoked; service_role only) — CREATE OR REPLACE preserves the ACL (drain_fmv_cold_tail)
--
-- REVERT: re-apply the drain_fmv_cold_tail block of the base migration named above.

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
  v_ask_fell        INT := 0;
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
    ),
    -- 2026-10-22: a SECOND arm, Top Shot only. An ASK_ONLY price is 0.90 x the
    -- ask on the day it was written, and nothing re-priced a sale-less edition
    -- for 7 days — so when the ask FELL, the published FMV sat ABOVE the
    -- cheapest listing for up to a week (75 editions read 10-22, median ~100 h,
    -- e.g. 284:9319 FMV $405 vs a $350 ask). This arm picks editions whose
    -- NEWEST snapshot is ASK_ONLY and above today's ask, with no 30-day sale
    -- (so the loop below takes its ask branch, never the sales branch), and
    -- re-stamps them at 0.90 x today's ask. Disjoint from the 7-day arm by
    -- construction (computed_at >= now() - 7 days). edition_fmv_current only
    -- NARROWS the scan (it lags fmv_snapshots); the LATERAL re-reads the real
    -- newest snapshot, so a lagging row can never clobber a newer price.
    ask_fell AS (
      SELECT c.edition_id, e.tier, cur.computed_at AS last_snapshot
      FROM edition_fmv_current c
      JOIN editions e ON e.id = c.edition_id
      JOIN badge_editions b
        ON b.external_id = e.external_id AND b.collection_id = e.collection_id
      JOIN LATERAL (
        SELECT fs.confidence, fs.fmv_usd, fs.computed_at
        FROM fmv_snapshots fs
        WHERE fs.collection_id = c.collection_id AND fs.edition_id = c.edition_id
        ORDER BY fs.computed_at DESC
        LIMIT 1
      ) cur ON true
      WHERE v_collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
        AND c.collection_id = v_collection_id
        AND c.confidence = 'ASK_ONLY'
        AND b.low_ask > 0 AND b.low_ask <= 10000
        AND c.fmv_usd > b.low_ask
        AND cur.confidence = 'ASK_ONLY'
        AND cur.fmv_usd > b.low_ask
        AND cur.computed_at >= NOW() - INTERVAL '7 days'
        AND NOT (e.external_id LIKE '%-%' AND e.set_id_onchain IS NULL)
        AND NOT EXISTS (
          SELECT 1 FROM public.sales_market s
          WHERE s.edition_id = c.edition_id
            AND s.sold_at > NOW() - INTERVAL '30 days'
            AND s.price_usd > 0
        )
    )
    SELECT edition_id, tier, last_snapshot, ask_fell
    FROM (
      SELECT edition_id, tier, last_snapshot, false AS ask_fell
      FROM candidates
      WHERE last_snapshot IS NULL OR last_snapshot < NOW() - INTERVAL '7 days'
      UNION ALL
      SELECT edition_id, tier, last_snapshot, true AS ask_fell
      FROM ask_fell
    ) u
    ORDER BY
      ask_fell DESC,
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
        IF v_edition_row.ask_fell THEN v_ask_fell := v_ask_fell + 1; END IF;
      ELSE
        -- An ask-fell row exists only to re-stamp from a live ask; if that ask
        -- vanished since selection, keep its (< 7 d) price rather than demote it.
        IF v_edition_row.ask_fell THEN CONTINUE; END IF;
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
      -- A sale landed since selection: the main sweep owns this edition now.
      IF v_edition_row.ask_fell THEN CONTINUE; END IF;
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
    'ask_fell_restamped', v_ask_fell,
    'no_data',         v_no_data,
    'elapsed_ms',      (EXTRACT(EPOCH FROM (clock_timestamp() - v_started_at)) * 1000)::INT,
    'started_at',      v_started_at,
    'threshold_days',  7
  );
END;
$function$;


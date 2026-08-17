-- audit_20260817_cold_tail_drain_scope_phantom_guard_to_topshot
--
-- `drain_fmv_cold_tail` excluded 100% of UFC Strike from the cold-tail sweep.
--
-- THE BUG. The candidate filter carried a Top-Shot-specific phantom guard applied
-- COLLECTION-BLIND:
--     AND NOT (e.external_id LIKE '%-%' AND e.set_id_onchain IS NULL)
-- It exists to skip Top Shot's UUID-keyed phantom editions (a UUID contains
-- hyphens and those rows have no resolved `set_id_onchain`). But UFC Strike's
-- `external_id` is a human-readable slug — e.g. `KHAMZAT-CHIMAEV-UFC-267-SUBMISSION-23970`
-- — where hyphens are the natural separator, and UFC legitimately has NO
-- `set_id_onchain` because it has no Top Shot set/play scheme. The predicate
-- therefore matches every UFC row BY CONSTRUCTION.
--
-- MEASURED 2026-08-17 (share of each collection's editions the guard excludes):
--     ufc_strike      518 / 518    = 100.0%   <-- entire collection removed
--     nba_top_shot  6,561 / 19,791 =  33.2%   <-- intended: the UUID phantoms
--     nfl_all_day       0 / 6,190  =   0.0%
--     laliga_golazos    0 / 575    =   0.0%
-- ⚠ The 6,561 figure independently reproduces the count of non-canonical Top Shot
-- `external_id`s measured the same day during the fossil-drain work, so the guard
-- is doing exactly its intended job for Top Shot and must be preserved there.
--
-- THE SYMPTOM, which had been visible for months in every run's own output:
-- `drain-fmv-cold-tail` reported `"collection_slug": "ufc_strike", "processed": 0`
-- on EVERY run while 366 UFC editions with sales sat unpriced. A per-collection
-- zero inside an otherwise-succeeding run is not "nothing to do" — it is the shape
-- a collection-blind filter makes.
--
-- STATE IT UNBLOCKS (measured, latest snapshot per UFC edition):
--     NO_DATA  316 editions, avg 75.9 days old, fmv_usd NULL on all 316
--     STALE    149 editions, avg 51.2 days old
--     (zero UFC editions at HIGH / MEDIUM / LOW / SALES_ONLY / ASK_ONLY)
-- 366 of them have sales behind them; the most-traded has 20,339. The drain cannot
-- do worse than the NULL price 316 of them carry today.
--
-- ⚠ SCOPE HONESTLY — this does NOT make UFC prices current, and must not be sold as
-- that. UFC Strike has **zero sales in the last 90 days** (newest 2026-05-13,
-- 813,934 historical), so `v_sales_count_30d = 0` for every row and the drain will
-- write `ASK_ONLY` (from `badge_editions.low_ask`) or `STALE` (median of the last 30
-- historical sales, carrying `days_since_sale`) rather than a live price. That is an
-- honest labelled price replacing a NULL, which is the improvement — not freshness.
-- ⚠ The 96-day UFC sales gap is a SEPARATE and larger question (`ufc-sales-indexer`:
-- 113 runs / 112 ok / 0 rows written in 7 days — the documented null instrument).
-- Filed separately; do NOT treat this migration as having addressed it.
--
-- CHANGE: scope the guard to Top Shot. Top Shot behaviour is preserved byte-for-byte
-- (same 6,561 excluded); AllDay and Golazos are unaffected (0 excluded either way);
-- UFC's 518 become eligible candidates for the first time.
--
-- Anon-exec decision: unchanged. This is a CREATE OR REPLACE of an existing
-- SECURITY DEFINER function; `CREATE OR REPLACE` preserves existing grants, and the
-- REVOKE below is restated so the decision is explicit in this migration rather than
-- inherited silently. Not anon-executable — admin/cron surface only.
--
-- REVERT: re-apply the previous definition, i.e. replace the guard block below with
--   AND NOT (e.external_id LIKE '%-%' AND e.set_id_onchain IS NULL)
-- (prior definition also recoverable from
--  supabase/migrations/20260711185416_audit_20260711_fmv_snapshots_rename_wap_to_asp.sql:581).

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
        -- Top-Shot-ONLY phantom guard. UUID-keyed Top Shot editions contain
        -- hyphens and have no resolved set_id_onchain. Scoped 2026-08-17: applied
        -- collection-blind it matched 100% of UFC Strike, whose external_id is a
        -- hyphenated human slug with a legitimately NULL set_id_onchain.
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

REVOKE EXECUTE ON FUNCTION public.drain_fmv_cold_tail(text, integer) FROM PUBLIC, anon, authenticated;

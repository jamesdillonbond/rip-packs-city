-- audit_20260826_cold_tail_drain_scope_latest_cte_to_collection
--
-- `drain_fmv_cold_tail` aggregated the WHOLE of `fmv_snapshots` on every call.
--
-- THE DEFECT. The candidate query opens with an UNSCOPED aggregate:
--     WITH latest AS (
--       SELECT edition_id, MAX(computed_at) AS last_snapshot
--       FROM fmv_snapshots
--       GROUP BY edition_id            -- <-- every row, every collection
--     )
-- and only then LEFT JOINs it to `editions` filtered to ONE collection. So a
-- drain of a 518-edition collection still grouped ~1.28M snapshot rows.
--
-- ⚠ A `LIMIT` bounds this query's OUTPUT, not its COST — the repo's standing
-- rule, and this is its cleanest instance: the LIMIT sits above the aggregate.
--
-- MEASURED 2026-08-26 ~04:15Z, ufc_strike (518 editions), EXPLAIN (ANALYZE,
-- BUFFERS), instance at io_wait 8 / active 11 (not in a saturation spell):
--
--                          buffers   snapshot rows   time       result
--   as-written (unscoped)   66,499      ~1,281,000   38,615 ms   0 rows
--   scoped (this change)       741           4,391      173 ms   0 rows
--                            ~90x           ~292x      ~223x     IDENTICAL
--
-- Both plans report "Rows Removed by Filter: 518" — the same 518 editions
-- examined, the same zero candidates returned. The scoped form is served by the
-- EXISTING covering index
-- `fmv_snapshots_2026_collection_id_edition_id_computed_at_idx` as an Index Only
-- Scan; no new index is created here.
--
-- ⭐ EQUIVALENCE IS PROVEN ON THE WHOLE POPULATION, NOT ARGUED. Scoping the CTE
-- changes the result only if a snapshot's `collection_id` can disagree with its
-- edition's. Measured across every row:
--     1,281,003 snapshots joined to editions
--             0 with collection_id DISTINCT FROM the edition's
--             0 with a NULL collection_id
-- So `MAX(computed_at) GROUP BY edition_id` restricted to a collection is
-- identical to the unscoped aggregate restricted to that collection's editions.
--
-- ⚠ NOTHING ELSE CHANGES. No pricing branch, no confidence threshold, no INSERT,
-- no ordering, no LIMIT semantics. This is one WHERE clause in the candidate
-- CTE. The `statement_timeout=120s` in `proconfig` is left as-is (and is INERT
-- per the repo's own finding — recorded, deliberately not "fixed" here).
--
-- anon-exec: unchanged — drain_fmv_cold_tail is ALREADY revoked in prod, and
-- CREATE OR REPLACE does not reset a function ACL. Verified live before and
-- after: anon=false, authenticated=false, service_role=true. A REVOKE here would
-- be the statement that CHANGES production, so there isn't one.
--
-- REVERT: re-apply the previous definition by deleting the single line
--     WHERE collection_id = v_collection_id
-- from the `latest` CTE below (prior body md5 cbe40bd986c8d6f9b1b3df76f3f07c7f,
-- also recoverable verbatim from
-- supabase/migrations/20260817221500_audit_20260817_cold_tail_drain_scope_phantom_guard_to_topshot.sql).

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
      -- ⚠ SCOPED 2026-08-26. Without this the aggregate grouped EVERY snapshot
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

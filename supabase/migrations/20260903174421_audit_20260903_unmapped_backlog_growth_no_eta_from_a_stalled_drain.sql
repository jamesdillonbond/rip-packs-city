-- audit_20260903_unmapped_backlog_growth_no_eta_from_a_stalled_drain
-- anon-exec: refresh_unmapped_backlog_growth — SECDEF, and the signature is unchanged, so
-- CREATE OR REPLACE preserves the existing ACL (anon EXECUTE stays false). Verified after apply.
--
-- ⭐ THE DEFECT. `days_to_drain` divides the actionable pile by `outflow_24h`, a TRAILING
-- 24-hour count. When a drain stops, that count keeps reporting the burst for a full day,
-- so the alert publishes an ETA computed from a rate that no longer exists.
--
-- Measured on production 2026-09-03: `nfl_all_day` published **"~32.6d to clear the
-- actionable pile"** off `outflow_24h` = 1,263, while the CURRENT drain was **10 rows in
-- 3 hours**. Steady state would put ~158 in that window, so the live rate was 6% of the
-- 24h average — and the honest ETA is nearer **526 days**, about 16x the published figure.
--
-- ⚠ IT DRIFTED IN THE REASSURING DIRECTION AND LOOKED FINE DOING IT. Three hours earlier
-- the same alert said 25.1 days; the number went UP while the true rate went DOWN, because
-- the numerator barely moves and the stale burst ages out of the window slowly. A decaying
-- series makes this read plausible at every single refresh.
--
-- The resolver itself is HEALTHY and simply out of tractable work: candidates per hour fell
-- 1,031 -> 17 and nearly all of the remainder come back `onchain_nil`. So this is not a
-- broken pipeline to fix, it is an alert making a claim its data cannot support.
--
-- THE FIX. Add `outflow_3h` — the same table and the same column as `outflow_24h`, over a
-- shorter window, so this is one instrument compared against itself rather than two
-- instruments paired. Steady state puts an eighth of the 24h outflow in any 3h window, so
-- `outflow_3h * 16 < outflow_24h` means the current rate is below HALF the 24h average.
-- When that holds, `drain_stalled` is true and NO ETA is published.
--
-- ⚠ A STALL IS NOT IDLENESS. `ufc_strike` has always reported `days_to_drain: null` with
-- zero outflow; `0 * 16 < 0` is false, so it stays `drain_stalled: false` and nothing about
-- it changes. Reading idle as stalled would invent a regression, and the pin asserts both.
--
-- Payload gains two keys (`outflow_3h`, `drain_stalled`); every existing key keeps its name,
-- type and meaning. The only behavioural change is that `days_to_drain` is NULL more often.
-- `get_pipeline_alerts_core` already wraps that sentence in COALESCE, so a NULL simply drops
-- the ETA clause rather than rendering "~d".
--
-- Pin: supabase/tests/refresh_unmapped_backlog_growth.sql (verbatim copy of the DDL below,
-- with the stall cases and their mutations). Registered in
-- __tests__/db-invariants-drift-guard.test.ts.
--
-- REVERT: re-apply the function body from
--   supabase/migrations/20260831133323_audit_20260831_unmapped_backlog_growth_fence_comment_correct_function_level_numbers.sql
-- which is the immediately prior definition, then revert the pin and the guard registration
-- to that migration. Reverting restores the stale-ETA behaviour; it loses no data.

CREATE OR REPLACE FUNCTION public.refresh_unmapped_backlog_growth()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '90s'
AS $function$
DECLARE
  v_payload jsonb;
BEGIN
  WITH tx AS (
    -- One row per (collection, transaction) over OPEN rows only. open_n > 1 marks a
    -- multi-NFT tx; those rows' price cannot be attributed per-NFT because
    -- decodeV1SaleTx returns a single gross DUC total for the whole transaction.
    --
    -- ⚠ THE `OFFSET 0` IS AN OPTIMIZATION FENCE AND IS LOAD-BEARING. DO NOT REMOVE IT.
    -- It blocks subquery pull-up so this scan is planned on its own, coming out as
    -- Seq Scan + HashAggregate instead of an Index Scan on unmapped_sales_dedup_idx
    -- (transaction_hash, nft_id, collection_id) that walks ~105k open rows in INDEX
    -- order and heap-fetches each one -- index order does not match heap order.
    --
    -- MEASURED AT THE FUNCTION LEVEL (the shape pg_cron actually calls), warm,
    -- 2026-08-31, by DO-block + clock_timestamp() with a RAISE to roll the write back:
    --     unfenced  1,550 ms   ->   fenced  560 ms     (2.8x)
    --
    -- 🚨 DO NOT SIZE THIS FROM AN INLINE `EXPLAIN`, AND THAT IS THE REAL LESSON HERE.
    -- Run as standalone SQL the unfenced CTE plans as that Index Scan and costs
    -- 102,550 buffers / 9,816 ms -- but the FUNCTION does not use that plan, and the
    -- production ticks it produces are ~2 s, not ~10 s. Both numbers are real; only the
    -- function-level pair describes what runs. A plpgsql function prepares and may plan
    -- its statements differently from the same text pasted into a session, so an inline
    -- EXPLAIN is a measurement of a DIFFERENT QUERY that happens to share your text.
    --
    -- `AS MATERIALIZED` also defeats the index path but was slower in the inline test
    -- (temp written 1,854 vs 631) because it round-trips every row through a tuplestore.
    -- Equivalence proven over the population both directions (EXCEPT each way = 0).
    SELECT
      s.collection_id,
      count(*)                                                  AS open_n,
      count(*) FILTER (WHERE COALESCE(s.price_usd,0) = 0)       AS open_unpriced_n
    FROM (
      SELECT u.collection_id, u.transaction_hash, u.price_usd
      FROM public.unmapped_sales u
      WHERE u.resolved_at IS NULL
      OFFSET 0
    ) s
    GROUP BY s.collection_id, s.transaction_hash
  ), unspl AS (
    SELECT
      t.collection_id,
      COALESCE(sum(t.open_unpriced_n) FILTER (WHERE t.open_n > 1), 0)::bigint AS open_gross_unsplittable_rows
    FROM tx t
    GROUP BY t.collection_id
  ), per_collection AS (
    SELECT
      u.collection_id,
      count(*) FILTER (WHERE u.resolved_at IS NULL)                                 AS open_rows,
      count(*) FILTER (WHERE u.resolved_at IS NULL AND COALESCE(u.price_usd,0) > 0) AS open_priced_rows,
      count(*) FILTER (WHERE u.ingested_at > now() - interval '24 hours')           AS inflow_24h,
      count(*) FILTER (WHERE u.ingested_at > now() - interval '24 hours'
                         AND u.sold_at    > now() - interval '7 days')              AS inflow_24h_fresh,
      count(*) FILTER (WHERE u.ingested_at > now() - interval '24 hours'
                         AND u.sold_at   <= now() - interval '7 days')              AS inflow_24h_backfill,
      count(*) FILTER (WHERE u.resolved_at  > now() - interval '24 hours')          AS outflow_24h,
      count(*) FILTER (WHERE u.resolved_at  > now() - interval '3 hours')           AS outflow_3h,
      min(u.sold_at) FILTER (WHERE u.resolved_at IS NULL)                           AS oldest_open_sold_at
    FROM public.unmapped_sales u
    GROUP BY u.collection_id
  ), scored AS (
    SELECT
      c.slug AS collection,
      p.open_rows,
      p.open_priced_rows,
      COALESCE(x.open_gross_unsplittable_rows, 0)                  AS open_gross_unsplittable_rows,
      p.open_rows - COALESCE(x.open_gross_unsplittable_rows, 0)    AS open_actionable_rows,
      p.inflow_24h,
      p.inflow_24h_fresh,
      p.inflow_24h_backfill,
      p.outflow_24h,
      p.outflow_3h,
      -- ⚠ THE 24h OUTFLOW IS A TRAILING COUNT AND IT LAGS A COLLAPSED DRAIN.
      -- Steady state puts an eighth of the 24h outflow in any 3h window, so
      -- `outflow_3h * 16 < outflow_24h` says the CURRENT rate is below HALF the
      -- 24h average — the window is still carrying a burst that has stopped.
      -- Same table and same column as outflow_24h, so this is one instrument
      -- compared against itself over two windows, not two instruments paired.
      (p.outflow_3h * 16 < p.outflow_24h) AS drain_stalled,
      p.inflow_24h - p.outflow_24h AS net_24h,
      CASE WHEN p.inflow_24h > 0
           THEN round(p.outflow_24h::numeric / p.inflow_24h, 4) END AS drain_ratio,
      CASE WHEN p.outflow_24h > p.inflow_24h_fresh
            AND NOT (p.outflow_3h * 16 < p.outflow_24h)
           THEN round((p.open_rows - COALESCE(x.open_gross_unsplittable_rows,0))::numeric
                      / (p.outflow_24h - p.inflow_24h_fresh), 1) END AS days_to_drain,
      p.oldest_open_sold_at,
      CASE
        WHEN (p.open_rows - COALESCE(x.open_gross_unsplittable_rows,0)) >= 10000
             AND p.inflow_24h_fresh > p.outflow_24h THEN 'high'
        WHEN (p.open_rows - COALESCE(x.open_gross_unsplittable_rows,0)) >=  1000
             AND p.inflow_24h_fresh > p.outflow_24h THEN 'medium'
        ELSE 'info'
      END AS severity
    FROM per_collection p
    JOIN public.collections c ON c.id = p.collection_id
    LEFT JOIN unspl x ON x.collection_id = p.collection_id
    WHERE p.open_rows >= 1000
  )
  SELECT COALESCE(jsonb_agg(to_jsonb(s) ORDER BY s.open_rows DESC), '[]'::jsonb)
    INTO v_payload
    FROM scored s;

  INSERT INTO public.unmapped_backlog_growth_cache (id, payload, row_count, refreshed_at)
  VALUES (1, v_payload, jsonb_array_length(v_payload), now())
  ON CONFLICT (id) DO UPDATE
    SET payload = EXCLUDED.payload,
        row_count = EXCLUDED.row_count,
        refreshed_at = EXCLUDED.refreshed_at;

  RETURN v_payload;
END;
$function$;

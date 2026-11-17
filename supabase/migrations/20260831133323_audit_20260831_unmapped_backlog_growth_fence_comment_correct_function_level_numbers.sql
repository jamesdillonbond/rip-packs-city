-- audit_20260831_unmapped_backlog_growth_fence_comment_correct_function_level_numbers
-- anon-exec: refresh_unmapped_backlog_growth — SECDEF ACL preserved by CREATE OR REPLACE. No behaviour change.
--
-- ⛔ COMMENT-ONLY CORRECTION to 20260831132548 (applied minutes earlier). The QUERY is byte-identical;
-- only the in-body comment changes. It is its own migration because the comment lives in `prosrc`, so
-- editing the previous migration's FILE would have drifted the pin away from prod.
--
-- 🚨 WHY: 20260831132548's comment sized the fence from an INLINE `EXPLAIN` — 102,791 buffers / 10,725 ms
-- unfenced vs 9,296 / 1,507 fenced. Those readings are REAL but they describe a plan THE FUNCTION DOES
-- NOT USE. The production ticks that same body produces are ~2 s, not ~10 s, which is the tell: a plpgsql
-- function prepares its statements and may plan them differently from the same text pasted into a session.
--
-- ⭐ RE-MEASURED AT THE FUNCTION LEVEL — the shape pg_cron actually calls — warm, by DO-block +
-- clock_timestamp() with a RAISE to roll the write back (so the cache row is untouched):
--     unfenced  1,550 ms   ->   fenced  560 ms     (2.8x, not the 7x the inline numbers implied)
-- The fix is still a real win; it is a SMALLER win than first published, and the comment now says so.
--
-- ⚠ The falsifier for the ORIGINAL claim also came back honest and is recorded: jobid 261's first
-- post-fix tick was 3.01 s against pre-fix ticks of 2.08–2.14 s on the same slots, i.e. n=1 shows NO
-- improvement on a WARM tick. The job is BIMODAL (usually ~2 s, 60 kills at the 120 s DB-level ceiling
-- in 14 days); this change targets the cold/contended tail, and confirming THAT needs a bad IO band,
-- not one tick.
--
-- REVERT: re-apply 20260831132548 (identical query, older comment), or the pre-fence body from
-- 20260810030734 to remove the fence entirely.

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
      p.inflow_24h - p.outflow_24h AS net_24h,
      CASE WHEN p.inflow_24h > 0
           THEN round(p.outflow_24h::numeric / p.inflow_24h, 4) END AS drain_ratio,
      CASE WHEN p.outflow_24h > p.inflow_24h_fresh
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
DO $mig$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'refresh_unmapped_backlog_growth'
      AND p.prosrc LIKE '%OFFSET 0%' AND p.prosrc LIKE '%FUNCTION LEVEL%'
      AND p.prosecdef AND p.proconfig @> ARRAY['search_path=public']
  ) THEN
    RAISE EXCEPTION 'POST-STATE FAILED: fence or corrected comment or SECDEF/search_path missing';
  END IF;
END
$mig$;

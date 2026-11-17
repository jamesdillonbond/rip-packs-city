-- audit_20260905: the unmapped-drain stall test measured the wrong thing, and its
-- ETA divided by a window too narrow to be stationary. Two changes, one transaction,
-- because the payload and the only reader of the payload must not drift apart.
--
-- WHAT WAS WRONG
--   drain_stalled was `outflow_3h * 16 < outflow_24h`. That is a RATIO of one trailing
--   count against another, so it fires whenever the 24h window happens to carry a burst
--   the last 3h did not. Measured over the resolver's entire 171h life it is true 45.8%
--   of the time -- an alarm that is on half the time carries no information, and the
--   alarm's only job is to null out the ETA, so the ETA is suppressed half the time too.
--   A tighter retune was tested and is WORSE: `12h x 2` measures 60.4%.
--
-- WHAT REPLACES IT (liveness, never a rate)
--   drain_stalled := last resolution older than 12h (or no resolution ever).
--   Calibrated against the real gap distribution for nfl_all_day, 5,571 consecutive
--   gaps over the resolver's whole history (first resolution 2026-08-29 16:37Z):
--       max gap 6.00h   p99 0.74h   gaps over 6h: 0   over 12h: 0
--   So a 12h threshold would have fired ZERO times historically, and it cannot be
--   fooled by a burst, because it never divides one window by another.
--   At apply time the live quiet period is 9.56h -- already longer than any gap this
--   resolver has ever closed, and still correctly below the threshold. If it crosses
--   12h the alert fires, and that firing will be the first true positive this arm has
--   ever produced.
--
-- WHAT ALSO CHANGES (the ETA stops pretending to be a point estimate)
--   The 24h and 7d windows disagree by two orders of magnitude, and BOTH are honest:
--       24h net = 33 - 17 = 16/day  -> ~2,627d
--       7d  net = (5572 - 126)/7    -> ~54d
--   because this resolver works in intermittent bulk sweeps (4,297 rows on 09-02, 899
--   on 09-03, 43 on 09-04, 8 on 09-05, against a ~60-110/day baseline before that).
--   Neither number is a schedule. Publishing either one alone is a failed read rendered
--   as an answer. So the payload now carries days_to_drain_24h AND days_to_drain_7d,
--   and when they disagree by more than 3x the alert prints the RANGE and says the rate
--   is not stationary instead of picking a winner. days_to_drain is retained for
--   back-compat and now carries the 7d figure (NULL while stalled).
--
-- ANON-EXECUTE DECISION. Neither function is anon/authenticated-executable. Both are
--   SECDEF with acl {postgres=X/postgres,service_role=X/postgres}; signatures are
--   UNCHANGED (both take zero arguments), so CREATE OR REPLACE cannot create a new
--   default-PUBLIC overload and a REVOKE here would be a no-op that pretends to be a
--   change. Re-verified after apply. The two machine-readable markers:
-- anon-exec: intentional — already revoked; CREATE OR REPLACE does not reset a function ACL (refresh_unmapped_backlog_growth)
-- anon-exec: intentional — already revoked; CREATE OR REPLACE does not reset a function ACL (get_pipeline_alerts_core)
--
-- ⚠ THIS FILE DIVERGES FROM supabase_migrations.schema_migrations.statements BY EXACTLY
--   THIS COMMENT BLOCK, and by nothing else. The applied statement carried a prose
--   `-- anon-exec:` line that did NOT name either function on its own line, and
--   `__tests__/migration-new-function-states-its-anon-exec-decision.test.ts` keys the
--   marker PER FUNCTION NAME — so it reded main. The two marker lines above were added
--   post-apply. Applied-statement md5 78551566e6300612ba060cd146db1791 (14,703 chars);
--   the executable SQL is untouched.
--
-- REVERT:
--   Restore both function bodies from the prior migrations. Pre-change identities:
--     refresh_unmapped_backlog_growth() prosrc md5 1ed85b363483d0dfc84ff856b6bb7ff3 (5925 chars)
--     get_pipeline_alerts_core()        prosrc md5 cd6f8de962e140d2b681fd1f29b6e2c4 (13003 chars)

CREATE OR REPLACE FUNCTION public.refresh_unmapped_backlog_growth()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '90s'
AS $fn$
DECLARE
  v_payload jsonb;
BEGIN
  WITH tx AS (
    -- One row per (collection, transaction) over OPEN rows only. open_n > 1 marks a
    -- multi-NFT tx; those rows' price cannot be attributed per-NFT because
    -- decodeV1SaleTx returns a single gross DUC total for the whole transaction.
    --
    -- THE `OFFSET 0` IS AN OPTIMIZATION FENCE AND IS LOAD-BEARING. DO NOT REMOVE IT.
    -- It blocks subquery pull-up so this scan is planned on its own, coming out as
    -- Seq Scan + HashAggregate instead of an Index Scan on unmapped_sales_dedup_idx
    -- (transaction_hash, nft_id, collection_id) that walks ~105k open rows in INDEX
    -- order and heap-fetches each one -- index order does not match heap order.
    --
    -- MEASURED AT THE FUNCTION LEVEL (the shape pg_cron actually calls), warm,
    -- 2026-08-31, by DO-block + clock_timestamp() with a RAISE to roll the write back:
    --     unfenced  1,550 ms   ->   fenced  560 ms     (2.8x)
    --
    -- DO NOT SIZE THIS FROM AN INLINE `EXPLAIN`, AND THAT IS THE REAL LESSON HERE.
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
      -- 7-DAY WINDOW (added 2026-09-05). Wide enough to contain a bulk sweep AND the
      -- quiet stretch after it, which is the only way to see that the two disagree.
      count(*) FILTER (WHERE u.resolved_at  > now() - interval '7 days')            AS outflow_7d,
      count(*) FILTER (WHERE u.ingested_at > now() - interval '7 days'
                         AND u.sold_at     > u.ingested_at - interval '7 days')     AS inflow_7d_fresh,
      -- LIVENESS. This is the one fact the ratio test could never report: when did this
      -- resolver last actually do something. It is a timestamp, not a rate, so no window
      -- choice can distort it.
      max(u.resolved_at)                                                            AS last_resolved_at,
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
      p.outflow_7d,
      p.inflow_7d_fresh,
      p.last_resolved_at,
      CASE WHEN p.last_resolved_at IS NOT NULL
           THEN round((extract(epoch FROM (now() - p.last_resolved_at)) / 3600.0)::numeric, 2)
      END AS drain_quiet_hours,
      -- REPLACED 2026-09-05. Was `outflow_3h * 16 < outflow_24h`, a ratio of two
      -- trailing counts that read TRUE 45.8% of the resolver's life and whose only
      -- effect was to null the ETA. This is a liveness test: has the resolver resolved
      -- ANYTHING in 12h. Calibrated on 5,571 consecutive gaps -- max 6.00h, p99 0.74h,
      -- zero gaps over 6h -- so it would have fired zero times historically.
      (p.last_resolved_at IS NULL
       OR p.last_resolved_at < now() - interval '12 hours')       AS drain_stalled,
      p.inflow_24h - p.outflow_24h AS net_24h,
      CASE WHEN p.inflow_24h > 0
           THEN round(p.outflow_24h::numeric / p.inflow_24h, 4) END AS drain_ratio,
      -- TWO ETAs, DELIBERATELY. They disagree by ~50x on nfl_all_day at apply time
      -- because this resolver works in intermittent bulk sweeps. The reader compares
      -- them and prints a range rather than a number when they diverge.
      CASE WHEN p.outflow_24h > p.inflow_24h_fresh
           THEN round((p.open_rows - COALESCE(x.open_gross_unsplittable_rows,0))::numeric
                      / (p.outflow_24h - p.inflow_24h_fresh), 1)
      END AS days_to_drain_24h,
      CASE WHEN p.outflow_7d > p.inflow_7d_fresh
           THEN round((p.open_rows - COALESCE(x.open_gross_unsplittable_rows,0))::numeric
                      / ((p.outflow_7d - p.inflow_7d_fresh)::numeric / 7.0), 1)
      END AS days_to_drain_7d,
      -- Back-compat key. Now the 7d figure, and NULL while the resolver is quiet.
      CASE WHEN NOT (p.last_resolved_at IS NULL
                     OR p.last_resolved_at < now() - interval '12 hours')
            AND p.outflow_7d > p.inflow_7d_fresh
           THEN round((p.open_rows - COALESCE(x.open_gross_unsplittable_rows,0))::numeric
                      / ((p.outflow_7d - p.inflow_7d_fresh)::numeric / 7.0), 1)
      END AS days_to_drain,
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
$fn$;

-- ---------------------------------------------------------------------------
-- Guarded splice of the ONLY reader of drain_stalled / days_to_drain.
-- Asserts the pre-change md5 and both anchors; RAISEs rather than half-editing.
-- ---------------------------------------------------------------------------
DO $mig$
DECLARE
  v_src   text;
  v_new   text;
  v_start text := $a$CASE WHEN (e->>'drain_stalled')::boolean$a$;
  v_end   text := $b$'d to clear the actionable pile. ', '')$b$;
  v_s     int;
  v_e     int;
  v_repl  text;
BEGIN
  SELECT p.prosrc INTO v_src
    FROM pg_proc p
   WHERE p.proname = 'get_pipeline_alerts_core'
     AND p.pronamespace = 'public'::regnamespace;

  IF v_src IS NULL THEN
    RAISE EXCEPTION 'get_pipeline_alerts_core() not found';
  END IF;
  IF md5(v_src) <> 'cd6f8de962e140d2b681fd1f29b6e2c4' THEN
    RAISE EXCEPTION 'get_pipeline_alerts_core() drifted from the body this migration was written against (md5 % len %)',
      md5(v_src), length(v_src);
  END IF;

  v_s := position(v_start IN v_src);
  v_e := position(v_end   IN v_src);
  IF v_s = 0 OR v_e = 0 OR v_e <= v_s THEN
    RAISE EXCEPTION 'splice anchors not found or out of order (start % end %)', v_s, v_e;
  END IF;
  v_e := v_e + length(v_end);

  v_repl := $r$CASE WHEN (e->>'drain_stalled')::boolean
                       THEN 'NO ETA: the resolver is QUIET — ' ||
                            CASE WHEN (e->>'drain_quiet_hours') IS NULL
                                 THEN 'it has never resolved a single row for this collection'
                                 ELSE 'nothing resolved for ' || (e->>'drain_quiet_hours') || 'h'
                            END ||
                            ' (threshold 12h). This is a LIVENESS reading, not a rate: the widest gap ' ||
                            'this resolver has ever closed is 6.0h, so a 12h silence is outside anything ' ||
                            'it has done before and no ETA computed from a dead rate would mean anything. '
                       WHEN (e->>'days_to_drain_24h') IS NOT NULL
                        AND (e->>'days_to_drain_7d')  IS NOT NULL
                        AND (   (e->>'days_to_drain_24h')::numeric > 3 * (e->>'days_to_drain_7d')::numeric
                             OR (e->>'days_to_drain_7d')::numeric  > 3 * (e->>'days_to_drain_24h')::numeric )
                       THEN 'NO SINGLE ETA — the drain rate is NOT STATIONARY. The 24h window projects ~' ||
                            (e->>'days_to_drain_24h') || 'd and the 7d window ~' || (e->>'days_to_drain_7d') ||
                            'd; both are honest arithmetic over the same table. This resolver works in ' ||
                            'intermittent bulk sweeps, so neither is a schedule — the RANGE is the answer, ' ||
                            'and a plan that needs one number needs a resolver with a steady rate first. '
                       ELSE COALESCE('~' || (e->>'days_to_drain') || 'd to clear the actionable pile (7d net rate). ', '')$r$;

  v_new := left(v_src, v_s - 1) || v_repl || substr(v_src, v_e);

  IF position($c$drain_quiet_hours$c$ IN v_new) = 0
     OR position($d$days_to_drain_7d$d$ IN v_new) = 0
     OR position($e$NOT STATIONARY$e$ IN v_new) = 0
     OR position($g$the drain has STALLED$g$ IN v_new) <> 0 THEN
    RAISE EXCEPTION 'spliced body failed its post-conditions';
  END IF;

  EXECUTE 'CREATE OR REPLACE FUNCTION public.get_pipeline_alerts_core()'
       || ' RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER'
       || ' STABLE'
       || ' SET search_path = public SET statement_timeout = ''45s'''
       || ' AS ' || quote_literal(v_new);
END
$mig$;

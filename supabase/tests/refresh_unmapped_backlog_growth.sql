-- DB invariant: public.refresh_unmapped_backlog_growth — the precompute behind
-- the `unmapped_resolution_backlog_max` trust arm, on pg_cron `29 * * * *`.
--
-- WHY IT MATTERS. This is the other kind of high-stakes function: it writes no
-- product data, it writes a JUDGEMENT. `unmapped_resolution_backlog_max` is one
-- of the four arms breached on the live board as of 2026-08-15, and the arm's
-- own text says the fix is a permanent-failure REASON to exclude on rather than
-- a higher threshold — which is exactly what `open_gross_unsplittable_rows`
-- computes. If that number is wrong, the operator is told to work a backlog
-- that cannot be drained, or told a drainable one is permanent.
--
-- Two properties carry the weight:
--   1. UNSPLITTABLE rows are counted per (collection, transaction): a multi-NFT
--      tx cannot be priced per-NFT because decodeV1SaleTx returns one gross DUC
--      total for the whole transaction. `open_actionable_rows` subtracts them.
--   2. `days_to_drain` is NULL unless the backlog is genuinely draining. This is
--      the repo's "a number the data cannot support must not be manufactured"
--      rule: with outflow <= fresh inflow the ETA is undefined, and publishing a
--      negative or enormous one reads as a real estimate.
--
-- The function DDL below is VERBATIM from the committed migration
-- (supabase/migrations/20260906215343_audit_20260906_snapshot_five_spliced_functions_so_their_pins_can_be_repointed.sql),
-- whose body was verified byte-identical to live prod via prosrc md5 on
-- 2026-08-15. __tests__/db-invariants-drift-guard.test.ts fails CI on drift.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE public.collections (
  id   uuid primary key,
  slug text
);

CREATE TABLE public.unmapped_sales (
  id               bigserial primary key,
  collection_id    uuid,
  transaction_hash text,
  price_usd        numeric,
  sold_at          timestamptz,
  ingested_at      timestamptz,
  resolved_at      timestamptz
);

CREATE TABLE public.unmapped_backlog_growth_cache (
  id           int primary key,
  payload      jsonb,
  row_count    int,
  refreshed_at timestamptz
);

-- >>> BEGIN verbatim refresh_unmapped_backlog_growth (byte-identical to the migration/prod) >>>
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
$function$;
-- <<< END verbatim refresh_unmapped_backlog_growth <<<

INSERT INTO public.collections (id, slug) VALUES
  ('dee28451-5d62-409e-a1ad-a83f763ac070', 'nfl_all_day'),
  ('06248cc4-b85f-47cd-af67-1855d14acd75', 'laliga_golazos');

-- AllDay: 1,200 open rows. 100 of them sit in 50 multi-NFT transactions with a
-- zero price → UNSPLITTABLE. The rest are single-NFT and unpriced → actionable.
-- Ingested 10 days ago (2026-09-05 repoint: outside BOTH the 24h and the 7d
-- fresh-inflow windows, so the ETA arithmetic below sees a pile that is not
-- still arriving).
INSERT INTO public.unmapped_sales (collection_id, transaction_hash, price_usd, sold_at, ingested_at, resolved_at)
SELECT 'dee28451-5d62-409e-a1ad-a83f763ac070',
       'multi-' || ((g + 1) / 2)::text, 0,
       now() - interval '10 days', now() - interval '10 days', NULL
FROM generate_series(1, 100) g;                                  -- 50 txs x 2 rows
INSERT INTO public.unmapped_sales (collection_id, transaction_hash, price_usd, sold_at, ingested_at, resolved_at)
SELECT 'dee28451-5d62-409e-a1ad-a83f763ac070',
       'single-' || g::text, 0,
       now() - interval '10 days', now() - interval '10 days', NULL
FROM generate_series(1, 1100) g;

-- Golazos: only 10 open rows → below the >= 1000 reporting floor.
INSERT INTO public.unmapped_sales (collection_id, transaction_hash, price_usd, sold_at, ingested_at, resolved_at)
SELECT '06248cc4-b85f-47cd-af67-1855d14acd75', 'g-' || g::text, 0,
       now() - interval '10 days', now() - interval '10 days', NULL
FROM generate_series(1, 10) g;

SELECT public.refresh_unmapped_backlog_growth();

-- ── The reporting floor ────────────────────────────────────────────────────
SELECT _assert_eq((SELECT row_count::text FROM public.unmapped_backlog_growth_cache WHERE id=1), '1',
  'only collections at or above 1000 open rows are reported');
SELECT _assert_eq(
  (SELECT payload -> 0 ->> 'collection' FROM public.unmapped_backlog_growth_cache WHERE id=1),
  'nfl_all_day', 'the reported row is joined to the collection SLUG, not its uuid');

-- ⚠ UNSPLITTABLE vs ACTIONABLE ────────────────────────────────────────────
-- The whole point of the arm's "exclude on a permanent-failure REASON" note.
-- Counting the multi-NFT rows as actionable tells the operator to drain 1,200
-- rows when only 1,100 CAN be drained — the backlog then looks permanently
-- stuck for a reason nobody can find.
SELECT _assert_eq(
  (SELECT payload -> 0 ->> 'open_rows' FROM public.unmapped_backlog_growth_cache WHERE id=1),
  '1200', 'open_rows counts every unresolved row');
SELECT _assert_eq(
  (SELECT payload -> 0 ->> 'open_gross_unsplittable_rows' FROM public.unmapped_backlog_growth_cache WHERE id=1),
  '100', 'the 100 rows in multi-NFT transactions are unsplittable');
SELECT _assert_eq(
  (SELECT payload -> 0 ->> 'open_actionable_rows' FROM public.unmapped_backlog_growth_cache WHERE id=1),
  '1100', 'actionable = open - unsplittable');

-- A PRICED row inside a multi-NFT tx is not unsplittable — the gross-total
-- problem only applies to rows we could not price.
UPDATE public.unmapped_sales SET price_usd = 5 WHERE transaction_hash = 'multi-1';
SELECT public.refresh_unmapped_backlog_growth();
SELECT _assert_eq(
  (SELECT payload -> 0 ->> 'open_gross_unsplittable_rows' FROM public.unmapped_backlog_growth_cache WHERE id=1),
  '98', 'a priced row in a multi-NFT tx is not counted as unsplittable');

-- ⚠ days_to_drain is NULL unless the backlog is genuinely draining ─────────
-- Nothing has been resolved, so outflow is 0 and the ETA is undefined. Emitting
-- a number here would be an invented measurement, and with fresh inflow above
-- outflow the arithmetic would produce a NEGATIVE one. (2026-09-05: with no
-- resolution EVER, the liveness test also reads stalled — see below.)
SELECT _assert(
  (SELECT payload -> 0 -> 'days_to_drain' FROM public.unmapped_backlog_growth_cache WHERE id=1) = 'null'::jsonb,
  'days_to_drain is NULL while nothing is draining, never a negative ETA');
SELECT _assert(
  (SELECT payload -> 0 -> 'days_to_drain_24h' FROM public.unmapped_backlog_growth_cache WHERE id=1) = 'null'::jsonb
  AND (SELECT payload -> 0 -> 'days_to_drain_7d' FROM public.unmapped_backlog_growth_cache WHERE id=1) = 'null'::jsonb,
  'both window ETAs are NULL while nothing is draining');

-- Now drain some and re-check: with outflow above fresh inflow it becomes real.
UPDATE public.unmapped_sales SET resolved_at = now() - interval '1 hour'
 WHERE transaction_hash LIKE 'single-%' AND id IN (
   SELECT id FROM public.unmapped_sales WHERE transaction_hash LIKE 'single-%' LIMIT 100);
SELECT public.refresh_unmapped_backlog_growth();
SELECT _assert(
  (SELECT (payload -> 0 ->> 'days_to_drain')::numeric FROM public.unmapped_backlog_growth_cache WHERE id=1) > 0,
  'once outflow exceeds fresh inflow, a positive ETA is published');
-- 2026-09-05: TWO ETAs, deliberately. 100 resolved in the last hour with zero
-- fresh inflow: 1,100 open − 98 unsplittable = 1,002 actionable; the 24h figure
-- is 1,002 / 100 per day = 10.0d; the 7d figure spreads the same 100 over a
-- week = 70.1d. Both are honest; the
-- reader prints a range when they disagree. days_to_drain carries the 7d one.
SELECT _assert_eq(
  (SELECT payload -> 0 ->> 'days_to_drain_24h' FROM public.unmapped_backlog_growth_cache WHERE id=1),
  '10.0', 'days_to_drain_24h = actionable / (outflow_24h - inflow_24h_fresh)');
SELECT _assert_eq(
  (SELECT payload -> 0 ->> 'days_to_drain_7d' FROM public.unmapped_backlog_growth_cache WHERE id=1),
  '70.1', 'days_to_drain_7d = actionable / ((outflow_7d - inflow_7d_fresh) / 7)');
SELECT _assert_eq(
  (SELECT payload -> 0 ->> 'days_to_drain' FROM public.unmapped_backlog_growth_cache WHERE id=1),
  '70.1', 'the back-compat days_to_drain is the 7d figure');
SELECT _assert_eq(
  (SELECT payload -> 0 ->> 'outflow_24h' FROM public.unmapped_backlog_growth_cache WHERE id=1),
  '100', 'outflow_24h counts rows resolved in the window');

-- ⚠ ...AND THE ETA IS ONLY PUBLISHED WHILE THE DRAIN IS STILL LIVE ──────────
-- Positive control first: the 100 rows above were resolved an hour ago.
SELECT _assert_eq(
  (SELECT payload -> 0 ->> 'outflow_3h' FROM public.unmapped_backlog_growth_cache WHERE id=1),
  '100', 'outflow_3h sees a drain that is still running');
SELECT _assert_eq(
  (SELECT payload -> 0 ->> 'drain_stalled' FROM public.unmapped_backlog_growth_cache WHERE id=1),
  'false', 'a running drain is not stalled');
SELECT _assert(
  (SELECT (payload -> 0 ->> 'drain_quiet_hours')::numeric FROM public.unmapped_backlog_growth_cache WHERE id=1) BETWEEN 0.9 AND 1.1,
  'drain_quiet_hours reports how long since the last resolution');

-- ⭐ THE DEFECT THIS PINNED ON 2026-09-03, AND WHAT REPLACED IT ON 2026-09-05.
-- `outflow_24h` is a TRAILING count, so it keeps reporting a burst for a full
-- day after the burst stops. Production published "~32.6d to clear" off 1,263
-- resolved/24h while the CURRENT rate was 10 per 3h. The 09-03 fix flagged a
-- stall by RATIO (outflow_3h * 16 < outflow_24h) — measured over the resolver's
-- whole life that was TRUE 45.8% of the time, so it suppressed the ETA half
-- the time and carried no information. 2026-09-05 replaced it with LIVENESS:
-- stalled := last resolution older than 12h, or none ever. Calibrated on 5,571
-- consecutive gaps (max 6.00h, p99 0.74h) it would have fired zero times.
--
-- Move the SAME resolved rows to 10 hours ago: the 3h window empties, the 24h
-- window still carries them — and under the liveness rule this is NOT a stall.
UPDATE public.unmapped_sales SET resolved_at = now() - interval '10 hours'
 WHERE resolved_at IS NOT NULL;
SELECT public.refresh_unmapped_backlog_growth();
SELECT _assert_eq(
  (SELECT payload -> 0 ->> 'outflow_24h' FROM public.unmapped_backlog_growth_cache WHERE id=1),
  '100', 'the 24h window still counts them');
SELECT _assert_eq(
  (SELECT payload -> 0 ->> 'outflow_3h' FROM public.unmapped_backlog_growth_cache WHERE id=1),
  '0', 'but nothing has drained in the last 3h');
SELECT _assert_eq(
  (SELECT payload -> 0 ->> 'drain_stalled' FROM public.unmapped_backlog_growth_cache WHERE id=1),
  'false', 'a 10h quiet spell is inside the 12h liveness bar — the ratio test would have (wrongly) called this a stall');
SELECT _assert(
  (SELECT (payload -> 0 ->> 'days_to_drain')::numeric FROM public.unmapped_backlog_growth_cache WHERE id=1) > 0,
  'so the ETA is still published');

-- 13 hours: past the bar. Stalled, and the back-compat ETA is withheld — an
-- ETA off a rate that has stopped is a fabricated measurement.
UPDATE public.unmapped_sales SET resolved_at = now() - interval '13 hours'
 WHERE resolved_at IS NOT NULL;
SELECT public.refresh_unmapped_backlog_growth();
SELECT _assert_eq(
  (SELECT payload -> 0 ->> 'drain_stalled' FROM public.unmapped_backlog_growth_cache WHERE id=1),
  'true', 'no resolution for 13h is a stall');
SELECT _assert(
  (SELECT (payload -> 0 ->> 'drain_quiet_hours')::numeric FROM public.unmapped_backlog_growth_cache WHERE id=1) BETWEEN 12.9 AND 13.1,
  'and the payload says how long it has been quiet');
SELECT _assert(
  (SELECT payload -> 0 -> 'days_to_drain' FROM public.unmapped_backlog_growth_cache WHERE id=1) = 'null'::jsonb,
  'NO back-compat ETA is published while stalled');
SELECT _assert(
  (SELECT (payload -> 0 ->> 'days_to_drain_7d')::numeric FROM public.unmapped_backlog_growth_cache WHERE id=1) > 0,
  'the raw 7d figure is still carried for the reader that prints the range');

-- ⚠ NO RESOLUTION EVER is a stall under the liveness definition (last_resolved_at
-- IS NULL). Before 2026-09-05 the ratio test read this as "idle, not stalled"
-- (0*16 < 0 is false) — which is why a never-draining resolver could never
-- trip the alert. That was the gap the liveness rule closes on purpose.
UPDATE public.unmapped_sales SET resolved_at = NULL;
SELECT public.refresh_unmapped_backlog_growth();
SELECT _assert_eq(
  (SELECT payload -> 0 ->> 'drain_stalled' FROM public.unmapped_backlog_growth_cache WHERE id=1),
  'true', 'a collection that has NEVER resolved anything is stalled — liveness, not a ratio');
SELECT _assert(
  (SELECT payload -> 0 -> 'drain_quiet_hours' FROM public.unmapped_backlog_growth_cache WHERE id=1) = 'null'::jsonb,
  'with no resolution ever there is no quiet-hours figure to report');
SELECT _assert(
  (SELECT payload -> 0 -> 'days_to_drain' FROM public.unmapped_backlog_growth_cache WHERE id=1) = 'null'::jsonb,
  'and it publishes no ETA');

-- ── The inflow split: fresh vs backfill ───────────────────────────────────
-- The severity rule keys on inflow_24h_FRESH, not total inflow, precisely so a
-- history backfill landing old rows cannot be mistaken for a growing backlog —
-- the same sold_at-vs-ingested_at asymmetry that makes the UFC revival arm work.
INSERT INTO public.unmapped_sales (collection_id, transaction_hash, price_usd, sold_at, ingested_at, resolved_at)
SELECT 'dee28451-5d62-409e-a1ad-a83f763ac070', 'backfill-' || g::text, 0,
       now() - interval '200 days',        -- old market time = a backfill
       now() - interval '1 hour', NULL     -- ingested just now
FROM generate_series(1, 500) g;
SELECT public.refresh_unmapped_backlog_growth();
SELECT _assert_eq(
  (SELECT payload -> 0 ->> 'inflow_24h_backfill' FROM public.unmapped_backlog_growth_cache WHERE id=1),
  '500', 'rows sold long ago but ingested now are BACKFILL inflow');
SELECT _assert_eq(
  (SELECT payload -> 0 ->> 'inflow_24h_fresh' FROM public.unmapped_backlog_growth_cache WHERE id=1),
  '0', 'and none of them count as fresh inflow');
SELECT _assert_eq(
  (SELECT payload -> 0 ->> 'severity' FROM public.unmapped_backlog_growth_cache WHERE id=1),
  'info', 'a pure backfill surge does not raise severity — only FRESH inflow can');

-- ── Severity escalates on genuine fresh inflow ────────────────────────────
INSERT INTO public.unmapped_sales (collection_id, transaction_hash, price_usd, sold_at, ingested_at, resolved_at)
SELECT 'dee28451-5d62-409e-a1ad-a83f763ac070', 'fresh-' || g::text, 0,
       now() - interval '1 hour', now() - interval '1 hour', NULL
FROM generate_series(1, 400) g;
SELECT public.refresh_unmapped_backlog_growth();
SELECT _assert_eq(
  (SELECT payload -> 0 ->> 'severity' FROM public.unmapped_backlog_growth_cache WHERE id=1),
  'medium', 'fresh inflow above outflow with >=1000 actionable rows is medium');

-- ── An empty result is an empty ARRAY, never NULL ─────────────────────────
-- The consumer reads jsonb_array_length(); a NULL payload would make row_count
-- NULL and the arm unreadable rather than zero.
DELETE FROM public.unmapped_sales;
SELECT public.refresh_unmapped_backlog_growth();
SELECT _assert_eq((SELECT payload::text FROM public.unmapped_backlog_growth_cache WHERE id=1), '[]',
  'no qualifying collection yields an empty array, not NULL');
SELECT _assert_eq((SELECT row_count::text FROM public.unmapped_backlog_growth_cache WHERE id=1), '0',
  'and a row_count of 0 rather than NULL');

SELECT '✓ refresh_unmapped_backlog_growth invariants pass' AS result;
ROLLBACK;

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
-- (supabase/migrations/20260810030734_audit_20260809_unmapped_backlog_growth_precompute_cache.sql),
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
-- <<< END verbatim refresh_unmapped_backlog_growth <<<

INSERT INTO public.collections (id, slug) VALUES
  ('dee28451-5d62-409e-a1ad-a83f763ac070', 'nfl_all_day'),
  ('06248cc4-b85f-47cd-af67-1855d14acd75', 'laliga_golazos');

-- AllDay: 1,200 open rows. 100 of them sit in 50 multi-NFT transactions with a
-- zero price → UNSPLITTABLE. The rest are single-NFT and unpriced → actionable.
INSERT INTO public.unmapped_sales (collection_id, transaction_hash, price_usd, sold_at, ingested_at, resolved_at)
SELECT 'dee28451-5d62-409e-a1ad-a83f763ac070',
       'multi-' || ((g + 1) / 2)::text, 0,
       now() - interval '2 days', now() - interval '2 days', NULL
FROM generate_series(1, 100) g;                                  -- 50 txs x 2 rows
INSERT INTO public.unmapped_sales (collection_id, transaction_hash, price_usd, sold_at, ingested_at, resolved_at)
SELECT 'dee28451-5d62-409e-a1ad-a83f763ac070',
       'single-' || g::text, 0,
       now() - interval '2 days', now() - interval '2 days', NULL
FROM generate_series(1, 1100) g;

-- Golazos: only 10 open rows → below the >= 1000 reporting floor.
INSERT INTO public.unmapped_sales (collection_id, transaction_hash, price_usd, sold_at, ingested_at, resolved_at)
SELECT '06248cc4-b85f-47cd-af67-1855d14acd75', 'g-' || g::text, 0,
       now() - interval '2 days', now() - interval '2 days', NULL
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
-- outflow the arithmetic would produce a NEGATIVE one.
SELECT _assert(
  (SELECT payload -> 0 -> 'days_to_drain' FROM public.unmapped_backlog_growth_cache WHERE id=1) = 'null'::jsonb,
  'days_to_drain is NULL while nothing is draining, never a negative ETA');

-- Now drain some and re-check: with outflow above fresh inflow it becomes real.
UPDATE public.unmapped_sales SET resolved_at = now() - interval '1 hour'
 WHERE transaction_hash LIKE 'single-%' AND id IN (
   SELECT id FROM public.unmapped_sales WHERE transaction_hash LIKE 'single-%' LIMIT 100);
SELECT public.refresh_unmapped_backlog_growth();
SELECT _assert(
  (SELECT (payload -> 0 ->> 'days_to_drain')::numeric FROM public.unmapped_backlog_growth_cache WHERE id=1) > 0,
  'once outflow exceeds fresh inflow, a positive ETA is published');
SELECT _assert_eq(
  (SELECT payload -> 0 ->> 'outflow_24h' FROM public.unmapped_backlog_growth_cache WHERE id=1),
  '100', 'outflow_24h counts rows resolved in the window');

-- ⚠ ...AND THE ETA IS ONLY PUBLISHED WHILE THE DRAIN IS STILL RUNNING ───────
-- Positive control first: the 100 rows above were resolved an hour ago, so the
-- short window still sees them and the ETA above is legitimate.
SELECT _assert_eq(
  (SELECT payload -> 0 ->> 'outflow_3h' FROM public.unmapped_backlog_growth_cache WHERE id=1),
  '100', 'outflow_3h sees a drain that is still running');
SELECT _assert_eq(
  (SELECT payload -> 0 ->> 'drain_stalled' FROM public.unmapped_backlog_growth_cache WHERE id=1),
  'false', 'a running drain is not stalled');

-- ⭐ THE DEFECT THIS PINS, 2026-09-03. `outflow_24h` is a TRAILING count, so it
-- keeps reporting a burst for a full day after the burst stops, and
-- `days_to_drain` divides by it. Production published "~32.6d to clear the
-- actionable pile" off 1,263 resolved/24h while the CURRENT rate was 10 per 3h
-- — a real ETA nearer 526 days. ⚠ The published number had gone UP from 25.1d
-- three hours earlier while the true rate went DOWN, because the numerator
-- barely moves and the stale burst ages out slowly: **a decaying series makes
-- this read plausible and wrong, in the reassuring direction.**
--
-- Moving the SAME resolved rows out of the 3h window reproduces it exactly:
-- nothing about the pile changes, only the recency of the drain.
UPDATE public.unmapped_sales SET resolved_at = now() - interval '10 hours'
 WHERE resolved_at IS NOT NULL;
SELECT public.refresh_unmapped_backlog_growth();
SELECT _assert_eq(
  (SELECT payload -> 0 ->> 'outflow_24h' FROM public.unmapped_backlog_growth_cache WHERE id=1),
  '100', 'the 24h window still counts them — this is what makes the stale ETA look real');
SELECT _assert_eq(
  (SELECT payload -> 0 ->> 'outflow_3h' FROM public.unmapped_backlog_growth_cache WHERE id=1),
  '0', 'but nothing has drained recently');
SELECT _assert_eq(
  (SELECT payload -> 0 ->> 'drain_stalled' FROM public.unmapped_backlog_growth_cache WHERE id=1),
  'true', 'so the drain is flagged stalled');
SELECT _assert(
  (SELECT payload -> 0 -> 'days_to_drain' FROM public.unmapped_backlog_growth_cache WHERE id=1) = 'null'::jsonb,
  'and NO ETA is published — an ETA off a rate that has stopped is a fabricated measurement, '
  'which is exactly what the 24h-only arithmetic published in production');

-- ⚠ A STALL IS NOT THE SAME STATE AS NO FLOW AT ALL, and the flag has to keep
-- them apart: `ufc_strike` has always reported days_to_drain NULL with zero
-- outflow, and reading THAT as a stall would invent a regression. With no
-- outflow at all the predicate is 0*16 < 0, which is false.
UPDATE public.unmapped_sales SET resolved_at = NULL;
SELECT public.refresh_unmapped_backlog_growth();
SELECT _assert_eq(
  (SELECT payload -> 0 ->> 'drain_stalled' FROM public.unmapped_backlog_growth_cache WHERE id=1),
  'false', 'a collection that never drained is NOT stalled, it is idle');
SELECT _assert(
  (SELECT payload -> 0 -> 'days_to_drain' FROM public.unmapped_backlog_growth_cache WHERE id=1) = 'null'::jsonb,
  'and it still publishes no ETA, for the original reason');

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

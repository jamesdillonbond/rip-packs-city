-- audit_20260902_pipeline_runs_daily_keeps_numeric_extra_values_not_just_key_presence
-- anon-exec: rollup_pipeline_runs — SECURITY DEFINER, unchanged signature and ACL
-- (CREATE OR REPLACE preserves it); anon EXECUTE remains false (asserted below).
--
-- WHY, and it is not speculative — three separate measurements this week died on this gap.
--
-- `pipeline_runs` retains ~73 h. `pipeline_runs_daily` is indefinite, but of a run's `extra` it keeps
-- only `extra_key_counts` — **which keys were PRESENT, never what they said.** So every per-step
-- counter a pipeline emits is deleted three days after it is written, and any question about a change
-- older than that is unanswerable no matter how carefully it was framed.
--
--   • **deep-audit R30** set itself the falsifier *"split the backstop's kill share at this commit"*.
--     The commit landed 2026-08-28 06:09Z; the oldest retained `wallet-backfill%` row is
--     2026-08-30 00:45Z. `chunk_rows_lost` for the pre-side no longer exists anywhere.
--     ⭐ **An experiment whose measurement window is shorter than the time it takes anyone to read it
--     has no falsifier at all.**
--   • **fmv-recalc's historical fallback** failed on 350 of 350 runs, and establishing that took
--     `extra.historical_fallback` across four days — barely inside retention, and only by luck.
--   • **The two treadmills fixed tonight** (`sales-counterparty-backfill`,
--     `topshot-buyer-backfill-historical`) are both *"finds rows, converts none"*, which is a
--     statement about `extra` counters over weeks, not over three days.
--
-- WHAT THIS ADDS: `extra_num_sums` — for each (pipeline, day), the SUM of every NUMERIC-valued key in
-- that day's `extra` payloads. It composes with the existing column rather than replacing it:
-- `extra_key_counts` says how many runs carried the key, `extra_num_sums` says what they added up to,
-- so **mean = sum / count** is derivable and neither column is redundant.
--
-- Verified against the real data before shipping (yesterday vs today, one row each):
--   sales-counterparty-backfill  09-01 {batch: 34560, applied: 0,   recovered: 0}
--                                09-02 {batch:  6600, applied: 109, recovered: 109}   ← the fix, durably
--   topshot-buyer-backfill-historical 09-01 {exec_accounts_resolved: 2115, buyers_resolved: 0}
--                                                                       ← the treadmill, in one row
--
-- ⚠ THREE THINGS A READER MUST KNOW, because each is a way to misread this column.
--   1. **A SUM IS ONLY MEANINGFUL FOR A COUNTER.** Keys like `to_block`, `sealed_tip` or a cursor
--      height sum to nonsense. This column does not know which key is which — you do. Read the key,
--      not just the number.
--   2. **NULL means the column did not exist yet, NOT that the day had no numeric keys.** The rollup
--      re-aggregates only the last `p_days` (default 4), so every row older than this migration keeps
--      a NULL forever. Treating that NULL as 0 is the fabricated-number shape.
--   3. **Only keys at the TOP LEVEL of `extra` are summed.** A nested object (e.g.
--      `pack-events-ingest-backfill`'s `{opens: {rows_inserted: N}}`) contributes nothing — the same
--      limit `extra_key_counts` already has, kept deliberately rather than papered over, because
--      flattening would collide keys from different sub-objects.
--
-- COST: one extra pass over the `array_agg(r.extra)` the function already materialises, with the same
-- shape-defensive `jsonb_typeof(...) = 'object'` guard the key-count expression carries (a non-object
-- `extra` on ONE row would otherwise abort the INSERT for every pipeline in the window). Distinct
-- numeric keys per pipeline-day are tens, so the aggregate is bounded.
--
-- REVERT:
--   -- re-apply the previous rollup_pipeline_runs body (identical minus the extra_num_sums column),
--   ALTER TABLE public.pipeline_runs_daily DROP COLUMN extra_num_sums;
-- The column is inert without the function, and dropping it loses only data that did not exist before.

ALTER TABLE public.pipeline_runs_daily
  ADD COLUMN IF NOT EXISTS extra_num_sums jsonb;

COMMENT ON COLUMN public.pipeline_runs_daily.extra_num_sums IS
  'Sum of every NUMERIC top-level key in this pipeline-day''s pipeline_runs.extra payloads. Exists '
  'because pipeline_runs retains ~73 h and this table previously kept only extra_key_counts — key '
  'PRESENCE, never values — so every per-step counter was deleted three days after it was written and '
  'no question about an older change could be answered (deep-audit R30''s falsifier died exactly that '
  'way). Composes with extra_key_counts: mean = extra_num_sums -> k divided by extra_key_counts -> k. '
  '⚠ A SUM IS ONLY MEANINGFUL FOR A COUNTER — keys like to_block or a cursor height sum to nonsense; '
  'this column does not know which key is which. '
  '⚠ NULL means the column did not exist for that day (added 2026-09-02; the rollup only re-aggregates '
  'the last p_days), NOT that the day had no numeric keys — reading that NULL as 0 is the '
  'fabricated-number shape. '
  '⚠ Top-level keys only; nested objects contribute nothing, the same limit extra_key_counts has.';

CREATE OR REPLACE FUNCTION public.rollup_pipeline_runs(p_days integer DEFAULT 4)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '120s'
AS $function$
DECLARE
  v_cutoff date;
  v_upserted bigint;
  v_started timestamptz := clock_timestamp();
BEGIN
  -- Re-aggregate the last p_days UTC days every run. Idempotent + self-healing:
  -- a missed run recovers on the next pass, so long as p_days > raw retention.
  v_cutoff := (CURRENT_DATE - GREATEST(p_days - 1, 0));

  INSERT INTO public.pipeline_runs_daily AS d (
    pipeline, day, runs, ok_count, fail_count,
    rows_found, rows_written, rows_skipped,
    duration_ms_avg, duration_ms_p95, duration_ms_max,
    first_run_at, last_run_at, collection_slugs, last_error,
    extra_key_counts, extra_num_sums, refreshed_at
  )
  SELECT
    r.pipeline,
    (r.started_at AT TIME ZONE 'UTC')::date            AS day,
    count(*)::int                                       AS runs,
    count(*) FILTER (WHERE r.ok)::int                   AS ok_count,
    count(*) FILTER (WHERE NOT r.ok)::int               AS fail_count,
    sum(r.rows_found)::bigint,
    sum(r.rows_written)::bigint,
    sum(r.rows_skipped)::bigint,
    avg(r.duration_ms)::int,
    percentile_cont(0.95) WITHIN GROUP (ORDER BY r.duration_ms)::int,
    max(r.duration_ms)::int,
    min(r.started_at),
    max(r.started_at),
    (SELECT array_agg(DISTINCT s) FROM unnest(array_agg(r.collection_slug)) s WHERE s IS NOT NULL),
    (array_agg(r.error ORDER BY r.started_at DESC) FILTER (WHERE r.error IS NOT NULL))[1],
    (
      SELECT jsonb_object_agg(k, n)
      FROM (
        SELECT k, count(*) AS n
        -- SHAPE-DEFENSIVE: jsonb_object_keys ERRORS on a non-object jsonb, and one
        -- such row would abort this INSERT for every pipeline in the window.
        FROM unnest(array_agg(r.extra)) e,
             LATERAL jsonb_object_keys(
               CASE WHEN jsonb_typeof(e) = 'object' THEN e ELSE '{}'::jsonb END
             ) k
        GROUP BY k
      ) ek
    ),
    (
      -- VALUES, not just presence. See the column comment: a key's SUM is only
      -- meaningful when the key is a counter, and NULL here means "this day predates
      -- the column", never "no numeric keys". Same shape-defence as above — one
      -- non-object `extra` must not abort the whole window.
      SELECT jsonb_object_agg(k, s)
      FROM (
        SELECT kv.key AS k, sum((kv.value)::numeric) AS s
        FROM unnest(array_agg(r.extra)) e,
             LATERAL jsonb_each(
               CASE WHEN jsonb_typeof(e) = 'object' THEN e ELSE '{}'::jsonb END
             ) AS kv
        WHERE jsonb_typeof(kv.value) = 'number'
        GROUP BY kv.key
      ) es
    ),
    now()
  FROM public.pipeline_runs r
  WHERE r.started_at >= v_cutoff::timestamptz
    AND r.pipeline IS NOT NULL
  GROUP BY r.pipeline, (r.started_at AT TIME ZONE 'UTC')::date
  ON CONFLICT (pipeline, day) DO UPDATE SET
    runs             = EXCLUDED.runs,
    ok_count         = EXCLUDED.ok_count,
    fail_count       = EXCLUDED.fail_count,
    rows_found       = EXCLUDED.rows_found,
    rows_written     = EXCLUDED.rows_written,
    rows_skipped     = EXCLUDED.rows_skipped,
    duration_ms_avg  = EXCLUDED.duration_ms_avg,
    duration_ms_p95  = EXCLUDED.duration_ms_p95,
    duration_ms_max  = EXCLUDED.duration_ms_max,
    first_run_at     = LEAST(d.first_run_at, EXCLUDED.first_run_at),
    last_run_at      = GREATEST(d.last_run_at, EXCLUDED.last_run_at),
    collection_slugs = EXCLUDED.collection_slugs,
    last_error       = COALESCE(EXCLUDED.last_error, d.last_error),
    extra_key_counts = EXCLUDED.extra_key_counts,
    -- COALESCE, not a plain assignment: a re-aggregation of a day whose raw rows have
    -- been pruned away would otherwise blank a value that was correct when written.
    extra_num_sums   = COALESCE(EXCLUDED.extra_num_sums, d.extra_num_sums),
    refreshed_at     = now()
  -- MONOTONE GUARD (load-bearing): the oldest day in the window is PARTIALLY PRUNED
  -- by prune_pipeline_runs(3). Without this, re-aggregating a half-deleted day would
  -- overwrite a previously-complete row with a truncated count -- silently corrupting
  -- the very archive this table exists to preserve. Never regress a fuller row.
  WHERE EXCLUDED.runs >= d.runs;

  GET DIAGNOSTICS v_upserted = ROW_COUNT;

  -- NOTE: duration_ms is GENERATED on pipeline_runs -- never list it here.
  INSERT INTO public.pipeline_runs (pipeline, started_at, finished_at, rows_written, ok, extra)
  VALUES (
    'pipeline-runs-daily-rollup', v_started, clock_timestamp(),
    v_upserted::int, true,
    jsonb_build_object('days', p_days, 'cutoff', v_cutoff, 'upserted', v_upserted)
  );

  RETURN jsonb_build_object(
    'upserted', v_upserted,
    'days', p_days,
    'cutoff', v_cutoff,
    'total_rows', (SELECT count(*) FROM public.pipeline_runs_daily)
  );
END;
$function$;

DO $mig$
DECLARE
  v_res jsonb;
  v_sums jsonb;
  v_keys jsonb;
  v_direct numeric;
  v_rolled numeric;
  v_pipeline text;
  v_day date;
  v_key text;
BEGIN
  IF has_function_privilege('anon', 'public.rollup_pipeline_runs(integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POST-STATE FAILED: anon gained EXECUTE';
  END IF;

  -- Run it for real, one day, so the assertions below read what the cron will write.
  v_res := public.rollup_pipeline_runs(1);
  IF (v_res->>'upserted')::bigint = 0 THEN
    RAISE EXCEPTION 'POST-STATE FAILED: the rollup upserted nothing, so nothing below is tested';
  END IF;

  -- EQUIVALENCE, against the raw table rather than against itself: pick the pipeline-day with the
  -- most numeric keys, take one of them, and require the rolled-up sum to equal a direct sum.
  SELECT d.pipeline, d.day, d.extra_num_sums, d.extra_key_counts
    INTO v_pipeline, v_day, v_sums, v_keys
  FROM public.pipeline_runs_daily d
  WHERE d.day = CURRENT_DATE AND d.extra_num_sums IS NOT NULL
  ORDER BY (SELECT count(*) FROM jsonb_object_keys(d.extra_num_sums)) DESC
  LIMIT 1;

  IF v_pipeline IS NULL THEN
    RAISE EXCEPTION 'POST-STATE FAILED: no pipeline-day carries extra_num_sums — the column did not populate';
  END IF;

  -- extra_key_counts must SURVIVE. A rewrite that dropped it would leave this migration's own
  -- target looking perfect while deleting the column it is supposed to compose with.
  IF v_keys IS NULL OR v_keys = '{}'::jsonb THEN
    RAISE EXCEPTION 'POST-STATE FAILED: extra_key_counts was lost for % on %', v_pipeline, v_day;
  END IF;

  SELECT k INTO v_key FROM jsonb_object_keys(v_sums) k LIMIT 1;

  SELECT sum((r.extra -> v_key)::numeric) INTO v_direct
  FROM public.pipeline_runs r
  WHERE r.pipeline = v_pipeline
    AND (r.started_at AT TIME ZONE 'UTC')::date = v_day
    AND jsonb_typeof(r.extra -> v_key) = 'number';

  v_rolled := (v_sums ->> v_key)::numeric;

  IF v_direct IS DISTINCT FROM v_rolled THEN
    RAISE EXCEPTION 'POST-STATE FAILED: % on % key % — rolled % vs direct %',
      v_pipeline, v_day, v_key, v_rolled, v_direct;
  END IF;

  RAISE NOTICE 'post-state ok: % on % key % = % (matches a direct sum over pipeline_runs); % upserted',
    v_pipeline, v_day, v_key, v_rolled, v_res->>'upserted';
END
$mig$;

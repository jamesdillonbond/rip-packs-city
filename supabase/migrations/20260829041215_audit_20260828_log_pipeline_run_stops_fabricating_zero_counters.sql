-- audit_20260828_log_pipeline_run_stops_fabricating_zero_counters
--
-- 🚨 `log_pipeline_run` — the write path behind EVERY pipeline in the fleet — silently turns an
-- explicit NULL counter into a measured 0. That is the `?? 0` fabricated-measurement shape this
-- repo bans, sitting in the one function whose entire job is to make failure legible.
--
-- ── FOUND BY ITS EFFECT, NOT BY READING ─────────────────────────────────────
-- Tonight's `refresh_wmc_fmv_changed` skip rows were written with `p_rows_found/written/skipped
-- := null` and landed as `0 / 0 / 0`. They were supposed to be the honest shape.
-- ⚠ AND IT IS NOT NEW, NOR MINE ALONE. `supabase/functions/backfill-topshot-pack-supply/index.ts`
-- passes `rowsFound: null, rowsWritten: null, rowsSkipped: null` on its failed-targets path with
-- the comment *"A failed targets read is a FAILURE, not an empty batch. rows_* stay NULL"*.
-- They do not. Every such row in production reads `0 / 0 / 0`:
--   topshot-pack-pool-backfill · stage=targets · 5 most recent · rows_found/written/skipped all 0
-- **Two independent authors wrote NULL for "not measured" and the shared helper overwrote both.**
--
-- ⭐ A THIRD component already worked around it rather than fixing it: `lib/pipeline/heartbeat.ts`
-- writes `pipeline_runs` DIRECTLY, and its own header calls the `rows 0` marker shape
-- *"the fabricated-measurement class this repo bans (`?? 0` on a count): a marker row measures
-- nothing, so a 0 is a number nobody read, and it is what made a pipeline look inert in the
-- 2026-08-16 retirement sweep."* So the repo simultaneously BANS this shape, WORKS AROUND it,
-- and PINS it. This migration removes the reason for the workaround.
--
-- ── THE PINNED RATIONALE IS REFUTED, AND THAT IS WHY THIS IS A CHANGE AND NOT A WHIM ──
-- `__tests__/db-invariants-drift-guard.test.ts` and `supabase/tests/log_pipeline_run.sql` pin the
-- COALESCE with this stated cost:
--   *"if that reached the column, every downstream SUM() over pipeline_runs would go NULL and a
--    broken pipeline would read as healthy-but-empty"*
-- ⛔ **`SUM()` IGNORES NULLs.** It returns NULL only when EVERY input row in the group is NULL, so
-- a mixed group is unaffected — the stated failure mode does not exist for any pipeline that ever
-- records a real count. ⭐ And the all-NULL case is not hypothetical-and-untested: every
-- `*-heartbeat` pipeline already writes NULL counters through the direct-insert path, has done
-- for months, and `rollup_pipeline_runs` aggregates them without incident. **The invariant was
-- protecting against something already happening harmlessly elsewhere in the same table.**
-- Per this repo's rule, the pin is INVERTED, not deleted, and its rationale corrected in place.
--
-- ── BLAST RADIUS, BOUNDED WITH A SWEEP RATHER THAN ASSERTED ─────────────────
-- The three parameters carry `DEFAULT 0`, and a DEFAULT is applied when an argument is OMITTED —
-- so the ~129 call sites that pass numbers or omit the counters are BYTE-IDENTICAL after this.
-- ⭐ Only an EXPLICIT null changes behaviour, and a full sweep (repo `.ts`/`.tsx`/`.mjs`, the
-- `supabase/functions/**` edge fleet, `pg_proc.prosrc`, `pg_views`, `cron.job.command`) finds
-- exactly TWO such call sites — and both WANT NULL:
--   1. supabase/functions/backfill-topshot-pack-supply/index.ts  (failed-targets path, both modes)
--   2. app/api/wmc-fmv-populate/route.ts                          (skipped_concurrent_refresh)
--
-- ── EVERY DOWNSTREAM READER CHECKED, NOT ASSUMED ───────────────────────────
--   · `app/api/sentinel/route.ts`  `.gt("rows_written", 0)` — NULL fails `> 0` exactly as 0 does.
--     ⭐ Its Pipeline Success Coverage arm is "zero successes AND zero rows written", so a NULL
--     can only make the arm LESS likely to fire, never falsely fire.
--   · `rollup_pipeline_runs`  `sum(...)::bigint` into a NULLABLE column — proven by the heartbeat
--     rows that already land there NULL.
--   · `cohort_health_snapshot`  `SUM(rows_written)` — NULL-tolerant, renders NULL honestly.
--   · view `v_pack_pipeline_health`  `COALESCE(sum(...), 0)` — explicit, unaffected.
--   · view `pipeline_health`  scalar subselect — renders NULL, which is the honest reading.
--   · `app/api/sentinel/route.ts:1047`  `Number(r.rows_written ?? 0)` inside a running total —
--     adds 0 for a NULL, identical to today.
--
-- ⚠ WHAT CHANGES FOR A READER, STATED PLAINLY: a predicate written as `rows_written = 0` stops
-- matching these rows (a NULL is not equal to 0). That is the INTENDED effect — a row nobody
-- measured should not answer a question about measured zeros — but it is the one behavioural
-- difference, and no current reader uses that form.
--
-- ⚠ The 3-argument overload `log_pipeline_run(text, boolean, jsonb)` is UNTOUCHED and unaffected:
-- it COALESCEs its own counters out of `p_extra` before delegating, so it never passes NULL.
--
-- ⚠ `SECURITY DEFINER`, `SET search_path TO 'public'`, the parameter defaults, the return type
-- and the `clock_timestamp()` fix from 20260823190648 (which IS `pipeline_runs.duration_ms` —
-- `now()` there made the GREATEST-clamped duration a structural hard 0 for ten pipelines) are all
-- restated VERBATIM. Only the three COALESCE wrappers are removed.
-- anon-exec: unchanged (log_pipeline_run) -- CREATE OR REPLACE does not touch the ACL; verified
-- before and after.
--
-- REVERT (one statement's worth): re-create the function with
-- `COALESCE(p_rows_found,0), COALESCE(p_rows_written,0), COALESCE(p_rows_skipped,0)` restored,
-- and re-invert `supabase/tests/log_pipeline_run.sql`. No data is written or destroyed; existing
-- rows are untouched and remain 0.
--
-- EXIT CONDITION: `refresh_wmc_fmv_changed` skip rows and `topshot-pack-*-backfill` targets-failure
-- rows land with `rows_found / rows_written / rows_skipped` NULL instead of 0.
-- FALSIFIER: if any dashboard, arm or rollup starts reading NULL where it needs a number, this is
-- wrong and the revert above is one statement. The specific thing to watch is
-- `pipeline_runs_daily.rows_written` for those two pipelines — it should stay a number, because
-- both also write real counts on their success paths.

CREATE OR REPLACE FUNCTION public.log_pipeline_run(p_pipeline text, p_started_at timestamp with time zone, p_rows_found integer DEFAULT 0, p_rows_written integer DEFAULT 0, p_rows_skipped integer DEFAULT 0, p_ok boolean DEFAULT true, p_error text DEFAULT NULL::text, p_collection_slug text DEFAULT NULL::text, p_cursor_before text DEFAULT NULL::text, p_cursor_after text DEFAULT NULL::text, p_extra jsonb DEFAULT NULL::jsonb)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_id bigint;
BEGIN
  INSERT INTO public.pipeline_runs (
    pipeline, collection_slug, started_at, finished_at,
    rows_found, rows_written, rows_skipped,
    cursor_before, cursor_after, ok, error, extra
  ) VALUES (
    -- clock_timestamp(), NOT now(): now() is transaction start, which precedes
    -- the clock_timestamp() every caller passes as p_started_at, so duration_ms
    -- (GREATEST-clamped) was pinned at 0 for 10 pipelines.
    p_pipeline, p_collection_slug, p_started_at, clock_timestamp(),
    -- NO COALESCE: the parameters already carry DEFAULT 0, which covers every
    -- caller that OMITS a counter. An EXPLICIT NULL is a caller saying "I did not
    -- measure this", and coalescing it to 0 published a number nobody read --
    -- the fabricated-measurement shape this repo bans, in the fleet's own logger.
    p_rows_found, p_rows_written, p_rows_skipped,
    p_cursor_before, p_cursor_after, p_ok, p_error, p_extra
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$function$;

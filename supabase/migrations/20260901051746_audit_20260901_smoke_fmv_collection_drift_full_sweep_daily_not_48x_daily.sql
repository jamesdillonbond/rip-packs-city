-- audit_20260901_smoke_fmv_collection_drift_full_sweep_daily_not_48x_daily
-- anon-exec: analytics_smoke_run — NOT re-granted here. This migration does not write a CREATE OR REPLACE
-- literal at all: it reads pg_get_functiondef(), replaces ONE anchored snippet, and EXECUTEs the result, so
-- the signature, LANGUAGE, SECURITY, search_path and therefore the ACL are carried over verbatim by
-- construction. Nothing about who may execute it changes.
--
-- WHY (measured 2026-09-01). analytics_smoke_run() is the #4 consumer on the instance:
--     70,019 shared_blks_read and ~30 s per call, 48 calls/day (cron-job.org 'RPC Analytics Smoke', 13,43)
--     = ~3.4M blocks/day, roughly 26 GB/day of disk reads for a smoke test.
--
-- 41% of that is ONE check. Its own comment says the invariant is "structurally enforced by trigger", and
-- it verifies that by full-scanning the entire partitioned fmv_snapshots every 30 minutes:
--     SELECT count(*) FROM fmv_snapshots fs JOIN collections c ON c.id = fs.collection_id
--      WHERE fs.collection != c.slug;
--     -> Parallel Seq Scan on fmv_snapshots_2026, 1,368,392 rows scanned, 0 drift found
--     -> 28,862 buffers (26,364 of them physical reads), 1,496 ms -- 48x/day = ~10.6 GB/day
-- That is a guard costing far more than the thing it guards, run 48 times a day to re-answer a question
-- whose answer cannot change except by a write.
--
-- WHAT SHIPS: the check keeps BOTH scopes, chosen by the clock.
--   * 08:13Z tick (hour = 8, minute < 30): the FULL-history sweep, byte-identical to today's query.
--   * every other tick: the same query bounded to computed_at > now() - 2h, which rides
--     idx_fmv_snapshots_2026_computed_at_desc -- measured 310 buffers / 12.8 ms, 93x cheaper.
-- At a 30-minute cadence a 2-hour window covers every write four times over, so a trigger regression is
-- still caught within one tick. Full-history coverage becomes daily instead of half-hourly.
--     ~10.6 GB/day  ->  ~0.25 GB/day for this check.
--
-- ⚠ WHY A CLOCK GATE AND NOT SIMPLY A WINDOW. computed_at is BUSINESS time and is also the partition key --
-- there is no insert-time column on fmv_snapshots. So a backfill that writes rows with OLD computed_at
-- would never enter a computed_at-bounded window, and a window-only fix would silently stop covering
-- exactly the case (a bulk historical write) most likely to introduce drift. Keeping a real full sweep,
-- daily, closes that hole; a pure window would not. Do not "simplify" this to just the window.
--
-- ⚠ The result key stays 'integrity_fmv_snapshots_collection_drift' and the severity expression is
-- untouched ((detail->>'drift_rows')::int = 0 -> ok), so nothing downstream changes shape. A new
-- 'scope' key ('full_history' | 'recent_2h') is added to detail so a reader can always tell which ran.
--
-- ⚠ HOW THIS IS EDITED, AND WHY. The function body is 21 KB with 62 FROM clauses. Retyping it into a
-- migration is exactly the transcription this repo forbids for migrations, and a typo inside a smoke
-- suite blinds the monitor rather than failing loudly. So the edit is anchored and asserted: the anchor
-- must appear EXACTLY once (verified 2026-09-01: 1 occurrence), the replacement must change the text, and
-- the post-state re-reads the stored body. Everything outside the anchor is preserved bit-for-bit.
--
-- EXIT CONDITION (next pass):
--   SELECT * FROM public.ops_pgss_delta('3 hours', 50) WHERE q ILIKE '%analytics_smoke_run%';
--   PASS: blocks/call falls from ~70,019 toward ~41,000.
--   FALSIFIER: if a real collection-drift row ever appears, the daily full sweep must still catch it.
--   Check the daily 08:13Z run reports scope='full_history':
--     SELECT extra FROM pipeline_runs WHERE pipeline='analytics-smoke' ORDER BY started_at DESC LIMIT 5;
--
-- REVERT: re-run this migration's DO block with v_old and v_new SWAPPED (both literals are below, so the
--         revert is mechanical and needs no history lookup).

DO $mig$
DECLARE
  v_def   text;
  v_def2  text;
  v_hits  int;
  v_old   text := $old$SELECT jsonb_build_object('drift_rows', count(*)) INTO v_detail
      FROM fmv_snapshots fs JOIN collections c ON c.id = fs.collection_id
      WHERE fs.collection != c.slug;$old$;
  v_new   text := $new$IF EXTRACT(hour FROM now()) = 8 AND EXTRACT(minute FROM now()) < 30 THEN
        -- Once a day: the real full-history sweep. Kept because computed_at is business time and also
        -- the partition key, so a backfill writing old computed_at would never enter a bounded window.
        SELECT jsonb_build_object('drift_rows', count(*), 'scope', 'full_history') INTO v_detail
        FROM fmv_snapshots fs JOIN collections c ON c.id = fs.collection_id
        WHERE fs.collection != c.slug;
      ELSE
        -- Every other tick: same predicate, bounded to recent writes so it rides
        -- idx_fmv_snapshots_2026_computed_at_desc. 310 buffers vs 28,862 (measured 2026-09-01).
        -- At a 30-minute cadence a 2-hour window covers every write 4x, so a trigger regression is
        -- still caught within one tick.
        SELECT jsonb_build_object('drift_rows', count(*), 'scope', 'recent_2h') INTO v_detail
        FROM fmv_snapshots fs JOIN collections c ON c.id = fs.collection_id
        WHERE fs.collection != c.slug
          AND fs.computed_at > now() - interval '2 hours';
      END IF;$new$;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'analytics_smoke_run';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'PRE-STATE FAILED: public.analytics_smoke_run() not found';
  END IF;

  v_hits := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION 'PRE-STATE FAILED: expected exactly 1 occurrence of the anchor, found %. The body has changed since 2026-09-01 — re-derive the anchor rather than forcing this.', v_hits;
  END IF;

  v_def2 := replace(v_def, v_old, v_new);
  IF v_def2 = v_def THEN
    RAISE EXCEPTION 'PRE-STATE FAILED: replacement was a no-op';
  END IF;

  -- pg_get_functiondef carries the full CREATE OR REPLACE with every attribute, so this preserves
  -- signature / LANGUAGE / SECURITY DEFINER / search_path / ACL by construction.
  EXECUTE v_def2;
END
$mig$;

DO $post$
DECLARE
  v_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'analytics_smoke_run';

  IF v_def NOT LIKE '%''scope'', ''full_history''%' THEN
    RAISE EXCEPTION 'POST-STATE FAILED: the daily full-history branch is missing';
  END IF;
  IF v_def NOT LIKE '%''scope'', ''recent_2h''%' THEN
    RAISE EXCEPTION 'POST-STATE FAILED: the bounded branch is missing';
  END IF;
  -- The unbounded predicate must SURVIVE — it is the daily sweep, and losing it is the failure mode
  -- this migration is most likely to cause.
  IF v_def NOT LIKE '%WHERE fs.collection != c.slug;%' THEN
    RAISE EXCEPTION 'POST-STATE FAILED: the full-history predicate was lost';
  END IF;
  IF has_function_privilege('anon', 'public.analytics_smoke_run()', 'EXECUTE') THEN
    RAISE EXCEPTION 'POST-STATE FAILED: anon gained EXECUTE on analytics_smoke_run';
  END IF;
END
$post$;
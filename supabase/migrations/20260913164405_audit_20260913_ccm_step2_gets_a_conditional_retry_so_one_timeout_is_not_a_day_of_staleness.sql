-- `cross_collection_ts_set_overlap_mat` sat 41.3 h stale because
-- `rpc-ccm-step2` (pg_cron jobid 4, `25 23 * * *`) hit `canceling statement due to
-- statement timeout` at 300 s on 2026-09-12 16:25 PT, inside its
-- `CREATE TEMP TABLE _ccm_step2_next` step. The lane is DAILY, so a single
-- transient failure costs a full cycle and nothing revisits it — the same
-- permanent-hole shape as register #103, fixed the same way.
--
-- ⭐ MEASURED FIRST, AND IT REFUTED THE OBVIOUS FIX. The filing's suggested durable
-- option was "move step2 off the spell band". A 7-day per-hour breakdown of
-- `cron.job_run_details` says hour 23 UTC is one of the QUIETEST on the estate —
-- 0.4 % failed, avg 6.0 s — while the real spell band is 12–13 UTC (19.5 % and
-- 22.8 %) and 18 UTC (10.9 %). Moving the job would have bought nothing and cost a
-- reschedule. NOT the hour: the job's own cost has a fat tail against its ceiling.
--
-- ⭐ THE DISTRIBUTION, not a snapshot (last 14 runs): 9.7, 10.1, 32.8, 34.3, 43.2,
-- 18.6, 29.2, 25.8, 20.3, 22.8, 22.8, 165.2, 30.9, then TIMEOUT. Median ~25 s
-- against a 300 s cap — normally 12x headroom — but two of the last four runs used
-- 55 % and 100 % of it. A spell, not steady growth.
--
-- ⛔ WHY THE RETRY IS CONDITIONAL, which is where this departs from #103's
-- unconditional one. `refresh_cross_collection_cohort_step2()` TRUNCATEs
-- `cross_collection_ts_set_overlap_mat` — an ACCESS EXCLUSIVE lock on a table read
-- by the public, crawlable `/insights/cross-collection` board. That lock window was
-- DELIBERATELY shrunk on 2026-08-21 (pinned by
-- `supabase/tests/refresh_cross_collection_cohort_lock_window.sql`, which asserts
-- the reorder is output-equivalent). An unconditional daily retry would take that
-- lock a second time every day and partly undo a considered prior optimisation.
-- Gating on staleness takes it only on the ~7 % of days the primary actually fails.
--
-- ⭐ WHY 12 HOURS SEPARATES THE TWO CASES CLEANLY. `computed_at` is stamped from
-- `v_started := NOW()` at the TOP of the function, so it does not move with run
-- duration. Primary succeeded -> age at 04:37 UTC is 5.2 h (no fire). Primary
-- failed -> age is 29.2 h (fires). Both sides sit far from the threshold.
--
-- ⚠ `COALESCE(..., '-infinity')` is load-bearing and is the honesty guard: an EMPTY
-- mat makes `MAX(computed_at)` NULL, and `NULL < x` is NULL, which would read as
-- "fresh" and skip the retry exactly when the table has no data at all.
--
-- ⭐ WHY 04:37 UTC. Hours 02–05 UTC all measure 0.0 % failed over 7 days; hour 04
-- has the lowest tail (max 113.3 s). It is ~5 h after the primary and well before
-- the next day's step1 at 23:10 UTC, so `cross_collection_cohort_mat` — which step2
-- reads — is the fresh output of the same cycle. Slot verified free (0 jobs at
-- `37 4 * * *`; minute 37 avoids the documented 0/1/20/21/40/41 stagger ban).
--
-- ⭐ POSITIVE CONTROL TAKEN BEFORE SHIPPING: evaluated against live state at
-- 2026-09-13 09:3x PT, the predicate returns TRUE at the current 41.31 h age —
-- i.e. it fires on the very staleness that motivated it.
--
-- ⚠ EXPECTED EFFECT, stated so it is falsifiable: the observed primary failure rate
-- is 1 run in 14 (~7 %). One independent retry in a 0.0 %-failure hour should take
-- the >24 h staleness rate to roughly 0.5 %. FALSIFIED if
-- `cross_collection_ts_set_overlap_mat.max(computed_at)` is ever older than ~30 h
-- while this job reports `succeeded` — that would mean the gate skipped when it
-- should have fired; check the 12 h threshold against the actual age first.
--
-- ⚠ NOT FIXED BY THIS, deliberately: if the retry ALSO times out, the mat stays
-- stale until the next primary. That residual is accepted — the fix is for a
-- transient spell, not for a lane whose median cost has grown into its ceiling.
-- If the median climbs off ~25 s, bound the aggregate instead of adding legs.
--
-- REVERT: SELECT cron.unschedule('rpc-ccm-step2-retry');

SELECT cron.schedule(
  'rpc-ccm-step2-retry',
  '37 4 * * *',
  $job$
  DO $retry$
  BEGIN
    IF (SELECT COALESCE(MAX(computed_at), '-infinity'::timestamptz)
          FROM public.cross_collection_ts_set_overlap_mat)
       < NOW() - INTERVAL '12 hours'
    THEN
      PERFORM public.refresh_cross_collection_cohort_step2();
    END IF;
  END
  $retry$;
  $job$
);

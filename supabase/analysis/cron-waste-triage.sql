-- ══════════════════════════════════════════════════════════════════════════════
-- CRON WASTE TRIAGE — which pg_cron jobs are wasting time RIGHT NOW
-- ══════════════════════════════════════════════════════════════════════════════
--
-- Run it with the Supabase MCP `execute_sql`. It is READ-ONLY (one SELECT over
-- cron.job_run_details + cron.job) and mutates nothing.
--
-- ⚠ WHY THIS FILE EXISTS, and why the query it replaces was WRONG rather than
-- merely coarse. known-issues #42 built a triage that ranked jobs by
-- `sum(duration) WHERE status='failed'` over a fixed 7-day window. That
-- instrument went **0-for-4**: on 2026-08-29 it ranked jobid 211 FIRST by a
-- factor of four — 10,214 s of "reclaimable waste" — for a job that had been
-- FIXED the previous day by `idx_pack_rips_dist_agg` and whose every tick since
-- had succeeded in ~2 s. Same for jobids 4, 237 and 325. It advertised ~15,345 s
-- of savings across four healthy jobs.
--
-- ⭐ THE MECHANISM, which is general: **a pooled rate straddling a fix measures
-- the fix's ABSENCE and reads as its FAILURE.** A 7-day window contains every
-- change made in those 7 days, so the more actively a fleet is being repaired,
-- the more confidently a pooled ranking points at the jobs that were repaired.
-- CLAUDE.md records this class; #42's own instrument is where it landed.
--
-- ⭐ THE FIX IS NOT "use a shorter window." A short window cannot see a job that
-- runs daily, and shrinking it trades one blind spot for another. The fix is to
-- report the POOLED and RECENT windows SIDE BY SIDE and let the split decide,
-- which is what the `verdict` column does.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- THE FIVE VERDICTS — and why there are five rather than two
-- ══════════════════════════════════════════════════════════════════════════════
--
--   LIVE        Failing inside the recent window. THIS is reclaimable waste.
--               Rank by `wasted_recent_s`, never by `wasted_pooled_s`.
--
--   RECOVERED   Failed in the pooled window, zero failures recently, AND enough
--               recent runs that the silence is statistically meaningful.
--               Its pooled waste is HISTORICAL — there is nothing to reclaim.
--
--   UNPROVEN    Failed in the pooled window, zero failures recently, but too few
--               recent runs to tell recovery from luck.
--               ⚠ THIS IS THE COLUMN THAT KEEPS THE INSTRUMENT HONEST. A daily
--               job with a 30% failure rate shows zero failures across two runs
--               about half the time. Calling that "fixed" is the same error as
--               the pooled ranking, just pointing the other way — so the verdict
--               is derived from `p_null`, not from "has it failed lately".
--
--   SILENT      Failed in the pooled window and has run ZERO times recently.
--               ⛔ NOT recovered — NOT ANYTHING. A job that stopped running is
--               indistinguishable here from a job that was fixed, and the two
--               want opposite responses. This repo's standing rule that a failed
--               read must not render as an answer applies to its own
--               instruments: absence of failures is not evidence of health when
--               there is also an absence of runs.
--
--   UNSCHEDULED The jobid is gone from `cron.job` — someone removed the job.
--               Its waste is historical by definition. Surfaced rather than
--               silently dropped, because "where did that job go" is a real
--               question and the run history outlives the schedule.
--
-- ⭐ `p_null` = P(zero recent failures | the job's pooled failure rate was
-- unchanged) = (1 - pooled_rate) ^ runs_recent. It is this repo's recorded
-- discipline — *compute P(pass | the fix did nothing)* — applied to the triage
-- itself. p_null > 0.05 ⇒ UNPROVEN. A small p_null means the recent silence is
-- hard to explain WITHOUT a change; it does not say what the change was, and in
-- particular an UNSCHEDULED-then-rescheduled job or a cadence cut will also
-- produce one. **The verdict classifies; it does not diagnose.**
--
-- ══════════════════════════════════════════════════════════════════════════════
-- READING IT — the traps that are specific to this data
-- ══════════════════════════════════════════════════════════════════════════════
--
-- ⚠ `wasted_recent_s` and `wasted_pooled_s` cover DIFFERENT window lengths, so
--   they are not comparable. `wasted_recent_per_day` is the normalised figure —
--   compare that to `wasted_pooled_per_day` to see the trend.
--
-- ⚠ `status <> 'succeeded'` is used rather than `= 'failed'` deliberately.
--   pg_cron also writes 'canceled' (e.g. a job that unschedules ITSELF while
--   running — that is a self-cancel artifact, not a fault; seen 2026-08-31 on
--   the reindex wave's own teardown job) and transient 'running'/'starting'.
--   `end_time IS NOT NULL` excludes rows still in flight, which would otherwise
--   contribute a NULL duration and silently drop out of the sums.
--
-- ⚠ A pg_cron `status` is NOT its work's outcome. A job whose command COMMITs on
--   its own (REINDEX CONCURRENTLY, VACUUM) reports 'succeeded' for the dispatch
--   regardless of what the statement did, and a `net.http_get` job reports
--   'succeeded' when the request was QUEUED. **This instrument measures TIME
--   BURNED BY FAILING TICKS, not correctness.** For correctness read the
--   pipeline's own outcome table.
--
-- ⚠ `start_time` may include QUEUE WAIT (`cron.max_running_jobs` = 32 against
--   `max_worker_processes` = 6), so a duration is not necessarily statement
--   time. This is why the file ranks by waste and does NOT compute the
--   `max_ok / ceiling` ratio #42 used: that ratio carries queue-wait noise.
--
-- ⚠ Retention: `cron.job_run_details` held ~52 days as of 2026-08-31 — far more
--   than the 7 days #42 assumed. Widen `pooled` freely; it is not the constraint
--   it was believed to be. **Re-measure it rather than trusting this line.**
--
-- ══════════════════════════════════════════════════════════════════════════════

WITH params AS (
  -- Tune these two. `recent` must be long enough to contain several runs of the
  -- jobs you care about, or everything lands in UNPROVEN/SILENT and says nothing.
  SELECT interval '14 days' AS pooled,
         interval '48 hours' AS recent
),
runs AS (
  SELECT d.jobid,
         d.status,
         d.start_time,
         extract(epoch FROM (d.end_time - d.start_time)) AS secs,
         d.start_time > now() - p.recent AS is_recent
  FROM cron.job_run_details d
  CROSS JOIN params p
  WHERE d.start_time > now() - p.pooled
    AND d.end_time IS NOT NULL          -- exclude in-flight ticks (NULL duration)
),
agg AS (
  SELECT jobid,
         count(*)                                                              AS runs_pooled,
         count(*) FILTER (WHERE status <> 'succeeded')                         AS fails_pooled,
         round(COALESCE(sum(secs) FILTER (WHERE status <> 'succeeded'),0)::numeric, 0) AS wasted_pooled_s,
         count(*) FILTER (WHERE is_recent)                                     AS runs_recent,
         count(*) FILTER (WHERE is_recent AND status <> 'succeeded')           AS fails_recent,
         round(COALESCE(sum(secs) FILTER (WHERE is_recent AND status <> 'succeeded'),0)::numeric, 0) AS wasted_recent_s,
         round(COALESCE(max(secs) FILTER (WHERE status = 'succeeded'),0)::numeric, 0) AS max_ok_s,
         max(start_time) FILTER (WHERE status <> 'succeeded')                  AS last_fail
  FROM runs
  GROUP BY jobid
),
cls AS (
  SELECT a.*,
         -- P(zero recent failures | the pooled failure rate was unchanged).
         power(1.0 - a.fails_pooled::numeric / NULLIF(a.runs_pooled, 0), a.runs_recent) AS p_null
  FROM agg a
  WHERE a.fails_pooled > 0            -- a job that never failed has nothing to triage
)
SELECT
  c.jobid,
  COALESCE(j.jobname, '(UNSCHEDULED)')                                      AS jobname,
  CASE
    WHEN j.jobid IS NULL       THEN 'UNSCHEDULED'
    WHEN c.runs_recent = 0     THEN 'SILENT'
    WHEN c.fails_recent > 0    THEN 'LIVE'
    WHEN c.p_null > 0.05       THEN 'UNPROVEN'
    ELSE                            'RECOVERED'
  END                                                                       AS verdict,
  c.runs_recent,
  c.fails_recent,
  c.wasted_recent_s,
  round(c.wasted_recent_s / GREATEST(extract(epoch FROM (SELECT recent FROM params)) / 86400.0, 0.0001), 0) AS wasted_recent_per_day,
  c.runs_pooled,
  c.fails_pooled,
  c.wasted_pooled_s,
  round(c.wasted_pooled_s / GREATEST(extract(epoch FROM (SELECT pooled FROM params)) / 86400.0, 0.0001), 0) AS wasted_pooled_per_day,
  c.max_ok_s,
  round(extract(epoch FROM (now() - c.last_fail)) / 3600.0, 1)              AS hrs_since_fail,
  round(c.p_null, 3)                                                        AS p_null,
  j.schedule
FROM cls c
LEFT JOIN cron.job j ON j.jobid = c.jobid
ORDER BY
  -- LIVE first (the only class with anything to reclaim), then the two states
  -- that need a human decision, then the two that are closed.
  CASE
    WHEN j.jobid IS NULL    THEN 4
    WHEN c.runs_recent = 0  THEN 1   -- SILENT: a job that stopped running is a QUESTION
    WHEN c.fails_recent > 0 THEN 0   -- LIVE
    WHEN c.p_null > 0.05    THEN 2   -- UNPROVEN
    ELSE 3                           -- RECOVERED
  END,
  c.wasted_recent_s DESC,
  c.wasted_pooled_s DESC;


-- ══════════════════════════════════════════════════════════════════════════════
-- ARM 2 — `job startup timeout`, which ARM 1 IS STRUCTURALLY BLIND TO
-- ══════════════════════════════════════════════════════════════════════════════
--
-- ⚠ RUN THIS TOO. Arm 1 ranks per job by seconds burned, and that dissolves this
-- failure mode twice over:
--
--   1. **Its cost is MISSING WORK, not burned time.** pg_cron could not launch a
--      background worker, so the function body NEVER RAN — nothing reaches
--      `pipeline_runs`, and both `detect_stalled_pipelines()` and the cron-silent
--      checks are structurally blind to it. A tick that burns 600 s and a tick
--      that never happened are not comparable, and only one of them is visible
--      downstream. Ranking by seconds says the 600 s one matters ~20× more.
--   2. **It is a FLEET property, not a job property.** Measured 2026-08-31:
--      **260 startup timeouts in 72 h across 50 distinct jobs — 86.7/day** — but
--      only ~6,744 s total, so per job it is ~45 s/day and sorts near the bottom
--      of arm 1 every time. **The signal exists only when you stop grouping by
--      jobid**, which is precisely what arm 1 does.
--
-- ⭐ CAUSE, already diagnosed — do not re-derive it: `max_worker_processes = 6`
-- against `cron.max_running_jobs = 32`. pg_cron runs each job as a background
-- worker from that pool of 6, shared with parallel-query workers and the logical
-- replication launcher. More overlap than slots ⇒ `job startup timeout`.
-- ⛔ **The lever is NOT raising `max_worker_processes`** — it is compute-tier
-- linked, needs a restart, and CLAUDE.md forbids buying the way out.
-- **The lever is reducing OVERLAP.** Full case: docs/reference/cron-and-schedulers.md.
--
-- ⚠ READ THE HOUR COLUMN, NOT THE TOTAL. Run counts are FLAT across the day
-- (507–585/hour measured 2026-08-31) while startup timeouts swing 0 → 65, so this
-- is concurrency at particular hours, NOT load volume. 2026-08-31 sample: hours
-- 9/13/18/14/8 carried 65/55/54/45/26 and hours 0–7 and 20–23 carried ~0.
--
-- ⛔ BEFORE PROPOSING A RE-STAGGER, read the two recorded refutations in
-- cron-and-schedulers.md: a `:13` stagger was REFUTED for moving a job onto an
-- occupied slot, and a jobid-211 slot move was executed and reverted. **Verify the
-- DESTINATION slot is empty against live `cron.job`, not against the filing that
-- motivated the move** — and read the check ASYMMETRICALLY afterwards: silence is
-- weak evidence, but ONE `job startup timeout` falsifies the re-stagger outright.

SELECT
  extract(hour FROM d.start_time)::int                                   AS utc_hour,
  count(*) FILTER (WHERE d.return_message ILIKE '%startup timeout%')     AS startup_timeouts,
  count(DISTINCT d.jobid) FILTER (WHERE d.return_message ILIKE '%startup timeout%') AS distinct_jobs,
  count(*)                                                               AS all_runs,
  round(100.0 * count(*) FILTER (WHERE d.return_message ILIKE '%startup timeout%')
        / NULLIF(count(*), 0), 2)                                        AS pct_of_runs
FROM cron.job_run_details d
WHERE d.start_time > now() - interval '72 hours'
GROUP BY 1
ORDER BY startup_timeouts DESC;

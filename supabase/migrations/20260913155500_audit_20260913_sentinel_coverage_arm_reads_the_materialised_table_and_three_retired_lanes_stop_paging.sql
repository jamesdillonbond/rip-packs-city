-- audit_20260913: three sentinel/alerting corrections from the 09-13 07:36 PT sweep.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- (1) sentinel_edition_coverage() was ITSELF the load it kept timing out under.
--
-- The arm answers one question — "what share of live editions has ANY FMV
-- snapshot" — and answered it by LEFT JOINing every edition to the `fmv_current`
-- VIEW, which is `SELECT DISTINCT ON (edition_id) * FROM fmv_snapshots ORDER BY
-- edition_id, computed_at DESC`: a Merge Append + Unique over all ~1.2M snapshot
-- rows across three partitions, WITH heap fetches (it selects every column), to
-- discard everything but existence.
--
-- MEASURED (pg_stat_statements, live 2026-09-13 08:4x PT, since the last reset):
--   calls 320 · mean 6,532 ms · max 29,793 ms · total 2,090 s
--   shared blocks (hit+read) 22,970,531  → ~71,800 blocks (~560 MB) PER SWEEP
-- on the table CLAUDE.md books as the instance's #1 read hotspot. The 07:36 PT
-- sweep reported "Coverage RPC error: canceling statement due to statement
-- timeout" — the arm reads INCONCLUSIVE exactly when the DB is saturated, and
-- every sweep ADDS ~560 MB of reads to the saturation it is trying to measure.
-- CLAUDE.md: "your OWN PROBE is the load here."
--
-- The rewrite reads `edition_fmv_current` — the materialised "latest snapshot per
-- edition" table (migration 20260823173502), one row per edition that has EVER
-- had a snapshot, refreshed hourly and incrementally by refresh_edition_fmv_current()
-- at the top of refresh_series_detail_rollup() (cron jobid 357). 21,423 rows, 13 MB.
--
-- EQUIVALENCE, proven over the population rather than argued (live 09-13 08:5x PT):
--   editions 21,423 · editions with a row in edition_fmv_current 21,423
--   inert UUID-keyed TS editions 0 (the scope still exists; it is empty today)
--   edition_fmv_current rows with no editions row 0
-- so today's reading is identical (100.0%) by both definitions. ⚠ The direct
-- fmv_snapshots comparison was attempted twice under saturation and cancelled at
-- 50 s both times; the equality above is by the CACHE'S CONSTRUCTION (a row can
-- only exist if a snapshot did) plus the zero-orphan check, not by a side-by-side.
--
-- WHAT CHANGES IN MEANING, stated so the arm stays honest:
--   • The figure is a LOWER BOUND on coverage. A live edition whose FIRST snapshot
--     is younger than the last hourly refresh (watermark minus a 2 h safety lag)
--     counts as uncovered until the next refresh. That can only UNDER-report
--     coverage, never over-report it, so the 90% warn threshold cannot be
--     satisfied by staleness.
--   • If refresh_series_detail_rollup() dies, this arm's numerator freezes. That
--     lane carries its own 180-min cadence watchlist arm ('series-detail-rollup'),
--     so the freeze is not silent — but read that arm next to this one.
--   • The `inert_ts_uuid` scope is unchanged: the classification is on `editions`,
--     which this function still walks in full (21k rows, trivial).
--
-- REVERT: re-apply the prior body (verbatim from 20260810-era definition):
--   CREATE OR REPLACE FUNCTION public.sentinel_edition_coverage()
--    RETURNS TABLE(scope text, editions bigint, with_fmv bigint)
--    LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public','pg_temp'
--   AS $$ WITH classified AS (SELECT e.id, CASE WHEN e.collection_id =
--     '95f28a17-224a-4025-96ad-adf8a4c63bfd' AND e.external_id !~
--     '^[0-9]+:[0-9]+(::[0-9]+)?$' THEN 'inert_ts_uuid' ELSE 'live' END AS scope
--     FROM public.editions e)
--   SELECT c.scope, count(*)::bigint, count(*) FILTER (WHERE fc.edition_id IS NOT NULL)::bigint
--   FROM classified c LEFT JOIN public.fmv_current fc ON fc.edition_id = c.id GROUP BY c.scope; $$;
--
-- Grants: CREATE OR REPLACE preserves the existing ACL (postgres, service_role
-- EXECUTE; nothing for anon/authenticated) — verified with has_function_privilege
-- after apply, and check_secdef_anon_exec_drift() re-run.
-- anon-exec: unchanged — SNAPSHOT of an existing SECDEF function whose ACL already excludes anon/authenticated (measured after apply: anon false, authenticated false, service_role true); a REVOKE here would be a no-op pretending to be a decision (sentinel_edition_coverage)
CREATE OR REPLACE FUNCTION public.sentinel_edition_coverage()
 RETURNS TABLE(scope text, editions bigint, with_fmv bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH classified AS (
    SELECT
      e.id,
      CASE
        WHEN e.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
             AND e.external_id !~ '^[0-9]+:[0-9]+(::[0-9]+)?$'
        THEN 'inert_ts_uuid'
        ELSE 'live'
      END AS scope
    FROM public.editions e
  )
  SELECT
    c.scope,
    count(*)::bigint                                                   AS editions,
    -- edition_fmv_current holds one row per edition that has EVER had a snapshot
    -- (refreshed hourly; a lower bound — see the migration header). Existence is
    -- the only thing read here, so the stale-copy caveat on its VALUE columns
    -- (never display a price from it) does not apply.
    count(*) FILTER (WHERE fc.edition_id IS NOT NULL)::bigint          AS with_fmv
  FROM classified c
  LEFT JOIN public.edition_fmv_current fc ON fc.edition_id = c.id
  GROUP BY c.scope;
$function$;

COMMENT ON FUNCTION public.sentinel_edition_coverage() IS
  'Sentinel "Edition Coverage" arm. Share of live editions with ANY FMV snapshot, read from edition_fmv_current (materialised latest-snapshot-per-edition, refreshed hourly by refresh_series_detail_rollup / cron jobid 357) rather than the fmv_current VIEW. 2026-09-13: the view walk cost ~71,800 buffers and 6.5 s mean per sweep (320 calls, 22.97M blocks, max 29.8 s) and timed out under saturation; this reads 21k rows. The figure is a LOWER BOUND: an edition whose first snapshot postdates the last refresh counts as uncovered until the next one. Inert UUID-keyed TS rows are still classified on editions and reported separately.';

-- ─────────────────────────────────────────────────────────────────────────────
-- (2) offers-sweep `failure_rate`: the 09-13 page is the TAIL of a cause already
-- removed, not a live failure.
--
-- The suppression row for this pipeline (added 2026-08-30, dead host) was bounded
-- to 2026-09-13 00:00Z and lapsed on schedule. What the arm then saw was the 7
-- runs of 2026-09-11 00:28–19:31 PT (6 on UTC 09-11, 1 on UTC 09-12) — every one
-- fired by the dead-lane-backstop GHA step that was DISABLED the next day
-- (a79b553f0, "it revives a lane retired on purpose, against a decommissioned
-- host"). The lane has NO caller now: cron-job.org job 7712610 INACTIVE since
-- 09-07, its watchlist row retired the same night, the backstop step commented
-- out. Nothing has run since 09-11 19:31 PT and pipeline_runs confirms it.
--
-- v_pipeline_failure_rates is `day >= CURRENT_DATE - 2 HAVING sum(runs) >= 5`
-- (UTC days). At UTC 2026-09-14 the window holds ONE run and the arm clears by
-- itself. This row is therefore bounded to 02:00Z on 09-14 — two hours past the
-- moment the arm would clear anyway — so it hides nothing a longer bound would
-- not, and CANNOT mask a future revival: a re-wired lane that fails 5+ times
-- pages again on 09-14 exactly as it should.
--
-- The Zero-Yield Lanes warn on the same lane is left alone on purpose: it keys on
-- runs_recent >= 50 in a 7-day window, and that count drops below 50 when 09-06's
-- 72 runs leave the window on 09-14. A PERMANENT pipeline_zero_yield_suppressions
-- row for a one-day tail would outlive its reason.
--
-- REVERT: DELETE FROM public.pipeline_alert_suppression WHERE pipeline = 'offers-sweep';
UPDATE public.pipeline_alert_suppression
   SET reason = 'TAIL of a removed cause, 2026-09-13: the 7 failing runs in the 2-day window (09-11 00:28–19:31 PT, all HTTP 530 from the decommissioned public-api.nbatopshot.com) were fired by the dead-lane-backstop GHA step, disabled 09-12 (a79b553f0). The lane has NO caller: cron-job.org 7712610 INACTIVE since 09-07, watchlist row retired, backstop step commented out. v_pipeline_failure_rates clears by itself at UTC 2026-09-14 (window then holds 1 run < the 5-run floor); this bound is 2 h past that so a future re-wiring that fails still pages. Do not extend.',
       added_at = now(),
       expires_at = '2026-09-14 02:00:00+00'
 WHERE pipeline = 'offers-sweep';

INSERT INTO public.pipeline_alert_suppression (pipeline, reason, added_at, expires_at)
SELECT 'offers-sweep',
       'TAIL of a removed cause, 2026-09-13 — see migration 20260913155500. Expires by itself; do not extend.',
       now(),
       '2026-09-14 02:00:00+00'
 WHERE NOT EXISTS (SELECT 1 FROM public.pipeline_alert_suppression WHERE pipeline = 'offers-sweep');

-- ─────────────────────────────────────────────────────────────────────────────
-- (3) Three dead-host Top Shot lanes whose disposition was RECORDED on 09-04/09-05
-- were still paging "silent beyond the pipeline_runs retention window" on every
-- sweep (info severity, three lines of every Telegram message since ~09-11).
--
-- The watchlist rows were SEEDED mechanically on 2026-09-04 from a 73 h gap
-- profile, the same day two of the lanes were being retired. Dispositions, from
-- docs/overnight/inbox/2026-09-04T0220Z (§1 "RESOLVED — decided, not deferred")
-- and 2026-09-05T1015Z ("all three can be retired or acknowledged together"):
--   topshot-catalog-backfill   — UNSCHEDULED 09-04 (vercel.json 36 → 35); its
--                                three jobs have live owners (circulation on-chain
--                                09-03, tier + badges from the Atlas walk).
--   ingest-topshot-challenges  — wrote 0 rows on every healthy day back to 08-16;
--                                failing 1/day against HTTP 530 through 09-08,
--                                then stopped (caller is cron-job.org or the
--                                box's Task Scheduler — invisible from here).
--   topshot-misattrib-drain    — a PAUSED CLEANUP of a static five-year backlog
--                                (17,795 of 20,128 candidates have no sale in 90 d;
--                                feed measured at zero); nothing degrades while
--                                it stays off. Last run 09-08.
-- pipeline_runs_daily: none of the three has a row after 09-08.
--
-- An arm that can only say "silent" about a lane whose upstream is gone and whose
-- caller is off is not a signal; it is the noise the 09-05 filing named ("the one
-- thing that IS costing something every day is the alarm"). Rows are kept, with
-- the disposition in `notes`, so re-activating is one UPDATE when the upstream
-- decision (register #50 / Atlas port) is made.
--
-- REVERT: UPDATE public.pipeline_cadence_watchlist SET is_active = true
--         WHERE pipeline IN ('topshot-catalog-backfill','ingest-topshot-challenges','topshot-misattrib-drain');
UPDATE public.pipeline_cadence_watchlist
   SET is_active = false,
       notes = '[INACTIVE 2026-09-13 — dead-host lane with a RECORDED disposition (inbox 2026-09-04T0220Z §1 / 2026-09-05T1015Z): public-api.nbatopshot.com answers 530 since ~08-28; catalog-backfill UNSCHEDULED 09-04 with live owners for all three of its jobs, challenges wrote 0 rows even when healthy, misattrib-drain is a paused cleanup of a static backlog. No run since 09-08. Re-activate when the lane is ported (Atlas / on-chain) or the host returns.] '
               || COALESCE(notes, '')
 WHERE pipeline IN ('topshot-catalog-backfill', 'ingest-topshot-challenges', 'topshot-misattrib-drain')
   AND is_active = true;

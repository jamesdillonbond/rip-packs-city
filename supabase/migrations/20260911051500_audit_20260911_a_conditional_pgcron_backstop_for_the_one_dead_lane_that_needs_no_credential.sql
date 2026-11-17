-- ============================================================================
-- A CONDITIONAL pg_cron BACKSTOP FOR `wmc-fmv-populate` — 2026-09-10 PT
--
-- 🚨 WHY THIS LANE AND NO OTHER. On 2026-09-10 ten lanes lost every caller they
-- had: cron-job.org stopped after the Vercel spend-cap pause (#76) and GitHub
-- then delivered ZERO scheduled events for 2.8h+ (#80). The durable fix for the
-- other nine is a credential decision — they sit behind `INGEST_SECRET_TOKEN`
-- and copying a production secret into a `cron.job` command is the secrets/env
-- class that is off-limits to a session. ⭐ **`wmc-fmv-populate` is the
-- exception, measured rather than assumed: `app/api/wmc-fmv-populate/route.ts`
-- makes ZERO external fetches — it is a pure-database lane wearing an HTTP route
-- as a coat.** So pg_cron can drive it with no token, no Vercel and no GitHub in
-- the path, which removes the single point of failure that took it out for
-- ~12.5 hours.
--
-- ⭐ ONLY THREE OF ITS FIVE FUNCTIONS NEEDED A CALLER, which is why this job is
-- small. Derived from `cron.job.command` with a word-boundary match rather than
-- inferred: `refresh_wmc_fmv_changed` is already pg_cron (`7-57/10`) and
-- `backfill_wmc_fmv_confidence` is already pg_cron (`2-59/5`). The three with NO
-- caller but the dead HTTP route are `populate_wmc_fmv_from_snapshots`,
-- `populate_wmc_image` and `refresh_wmc_fmv_drift_active`. ⛔ Duplicating the
-- two that are already scheduled would only buy lock contention — the route's
-- own header records 83 of 84 lock timeouts in 48h landing one minute after each
-- jobid-303 firing.
--
-- ⚠ THE CADENCE QUESTION WAS ANSWERED BY RE-DERIVING IT, AND THE FIGURE IN THE
-- HANDOFF WAS 8.7x TOO HIGH. It recorded "~2,007 times a day (every ~43s)" and
-- declined to build on that basis. `wmc-fmv-populate` writes ~7 `pipeline_runs`
-- rows PER INVOCATION (one per collection), so lane rows are not invocations.
-- The invocation count is the `-heartbeat` lane: **692 in 72h = ~230/day, one
-- every ~6.3 min** (811 lane rows in 24h against 116 heartbeats the same day
-- confirms the ~7x factor). So a backstop never had to match 2,007.
--
-- ⭐ BUT THE BETTER ANSWER IS THAT IT SHOULD NOT RUN AT ALL WHEN THE REAL CALLER
-- IS ALIVE. Measured cost of one full pass, warm, after hours of starvation:
--     populate_wmc_fmv_from_snapshots (Top Shot, limit 50k)   707 ms /   8,436 buffers
--     populate_wmc_image              (Top Shot, limit 50k)    32 ms /   1,691 buffers
--     refresh_wmc_fmv_drift_active    (25, 20000)          16,365 ms / 197,082 buffers, 122 MB read
-- The drift refresh is 23x everything else put together, and this instance's
-- saturation is **IO-bound** (22 MB/s burst floor), so an unconditional 96-tick
-- day would add ~8–12 GB of reads for nothing whenever the HTTP caller is fine.
-- **So this is a true backstop: it reads one index lookup, and if the HTTP lane
-- has written a heartbeat inside `p_stale_minutes` it does NOTHING.** Idle cost
-- is a few buffers; it engages only when the caller is actually gone, and
-- disengages by itself the moment cron-job.org or GitHub comes back.
--
-- ⛔ IT DELIBERATELY DOES NOT WRITE UNDER `wmc-fmv-populate`, AND THAT IS THE
-- WHOLE HONESTY DECISION HERE. Writing the work under the lane's own name would
-- refresh `last_run` and SILENCE `detect_stalled_pipelines()` on exactly the
-- outage that matters — the HTTP caller being dead — which is the reasoning the
-- route's own heartbeat header already records for its `-heartbeat` suffix. The
-- work gets done; the caller's silence stays visible. A backstop must not
-- launder the failure it is compensating for.
--
-- ⚠ `p_stale_minutes` IS A PARAMETER SO BOTH BRANCHES ARE TESTABLE WITHOUT
-- FAKING DATA: `p_stale_minutes := 0` forces the takeover path, the default
-- exercises the stand-down path. A guard whose interesting branch cannot be
-- reached is a guard nobody has seen work.
--
-- REVERT:
--   SELECT cron.unschedule('rpc-wmc-fmv-populate-backstop');
--   DROP FUNCTION IF EXISTS public.rpc_wmc_fmv_populate_backstop(int);
-- Nothing else changes: the route, its five RPCs and the other two pg_cron jobs
-- are untouched.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.rpc_wmc_fmv_populate_backstop(p_stale_minutes int DEFAULT 15)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $fn$
DECLARE
  v_last_http   timestamptz;
  v_stale_min   numeric;
  v_took_over   boolean;
  v_rows_fmv    int := 0;
  v_rows_img    int := 0;
  v_rows_drift  int := NULL;
  v_per_coll    jsonb := '{}'::jsonb;
  v_rec         record;
  v_fmv         int;
  v_img         int;
  v_t0          timestamptz := clock_timestamp();
  v_extra       jsonb;
BEGIN
  -- The INVOCATION marker, not the lane rows: the route writes one
  -- `wmc-fmv-populate-heartbeat` per tick, so this is the only reading that says
  -- whether the HTTP caller itself is alive.
  SELECT max(pr.started_at) INTO v_last_http
    FROM public.pipeline_runs pr
   WHERE pr.pipeline = 'wmc-fmv-populate-heartbeat'
     AND pr.started_at > now() - interval '72 hours';

  v_stale_min := CASE WHEN v_last_http IS NULL THEN NULL
                      ELSE round((extract(epoch FROM (now() - v_last_http)) / 60)::numeric, 0) END;

  -- ⚠ NULL means "no heartbeat inside the 73h retention window", which is a
  -- DEAD caller, not an unknown one — so it takes over. The only ambiguity
  -- retention could introduce is a lane silent for three days, and a three-day
  -- silence is the case this exists for.
  v_took_over := v_last_http IS NULL OR v_last_http < now() - make_interval(mins => p_stale_minutes);

  IF v_took_over THEN
    -- Same arguments the route uses: force = false (NULL-only), limit 50,000.
    -- 50k is the route's verified-safe ceiling for the image join; do not raise
    -- it here without re-measuring there.
    FOR v_rec IN SELECT c.id, c.slug FROM public.collections c WHERE c.is_active ORDER BY c.slug LOOP
      v_fmv := COALESCE(public.populate_wmc_fmv_from_snapshots(v_rec.id, false, 50000), 0);
      v_img := COALESCE(public.populate_wmc_image(v_rec.id, false, 50000), 0);
      v_rows_fmv := v_rows_fmv + v_fmv;
      v_rows_img := v_rows_img + v_img;
      v_per_coll := v_per_coll || jsonb_build_object(v_rec.slug, jsonb_build_object('fmv', v_fmv, 'image', v_img));
    END LOOP;

    -- The drift refresh is global, runs once per pass, and is the expensive leg.
    -- ⚠ Its arguments are (deviation_pct, limit) — there is NO time window to
    -- widen for a sparser cadence, because it is CURSOR-gated on
    -- `fmv_snapshots.computed_at > rwfd_state.last_cutoff` (the route's own
    -- header corrects an earlier comment that claimed otherwise). So a slower
    -- tick covers MORE changes per pass rather than missing any.
    v_rows_drift := public.refresh_wmc_fmv_drift_active(25, 20000);
  END IF;

  v_extra := jsonb_build_object(
    'source',                  'pg_cron',
    'took_over',               v_took_over,
    'verdict',                 CASE WHEN v_took_over THEN 'http_caller_silent_backstop_ran'
                                    ELSE 'http_caller_alive_stood_down' END,
    'http_last_heartbeat_at',  v_last_http,
    'http_silent_minutes',     v_stale_min,
    'stale_threshold_minutes', p_stale_minutes,
    'rows_fmv',                CASE WHEN v_took_over THEN v_rows_fmv END,
    'rows_image',              CASE WHEN v_took_over THEN v_rows_img END,
    'rows_drift_active',       v_rows_drift,
    'per_collection',          CASE WHEN v_took_over THEN v_per_coll END,
    'elapsed_ms',              round(extract(epoch FROM (clock_timestamp() - v_t0)) * 1000),
    'note',                    'writes under its OWN lane name on purpose: a row under wmc-fmv-populate would refresh last_run and silence detect_stalled_pipelines on the dead HTTP caller'
  );

  -- ⚠ rows_* are NULL on a stand-down — it measured NOTHING — and real counts on
  -- a takeover. The 3-argument log_pipeline_run COALESCEs them to 0, which is a
  -- fabricated zero, so the 11-argument form is the only correct call.
  -- `ok` is TRUE in both branches: standing down is this function working, and
  -- the dead HTTP caller is already reported by `wmc-fmv-populate` going silent.
  PERFORM public.log_pipeline_run(
    p_pipeline        := 'wmc-fmv-populate-pgcron-backstop',
    p_started_at      := v_t0,
    p_rows_found      := CASE WHEN v_took_over THEN v_rows_fmv + v_rows_img END,
    p_rows_written    := CASE WHEN v_took_over THEN v_rows_fmv + v_rows_img END,
    p_rows_skipped    := NULL::int,
    p_ok              := true,
    p_error           := NULL::text,
    p_collection_slug := NULL::text,
    p_cursor_before   := NULL::text,
    p_cursor_after    := NULL::text,
    p_extra           := v_extra
  );

  RETURN v_extra;
END
$fn$;

COMMENT ON FUNCTION public.rpc_wmc_fmv_populate_backstop(int) IS
  'Conditional pg_cron backstop for the wmc-fmv-populate lane: if no wmc-fmv-populate-heartbeat row exists inside p_stale_minutes, runs the three RPCs that have no other scheduler (populate_wmc_fmv_from_snapshots, populate_wmc_image, refresh_wmc_fmv_drift_active); otherwise stands down after one index lookup. Writes under its own lane name so the dead HTTP caller stays visible to detect_stalled_pipelines. Added 2026-09-10 after cron-job.org and the GitHub scheduler both stopped (#76, #80).';

-- anon-exec: REVOKED below -- rpc_wmc_fmv_populate_backstop is ops-only, called by pg_cron as postgres; no user-facing surface reads it.
REVOKE ALL ON FUNCTION public.rpc_wmc_fmv_populate_backstop(int) FROM PUBLIC, anon, authenticated;
-- The REVOKE strips PUBLIC, which is where a pg_cron caller with no explicit
-- grant would get EXECUTE from; granting the job's role in the SAME migration is
-- what stops it failing as silence.
GRANT EXECUTE ON FUNCTION public.rpc_wmc_fmv_populate_backstop(int) TO postgres;

-- ⚠ SUPERSEDED MINUTES — see migration
-- `20260911052600_audit_20260911_move_the_wmc_backstop_out_of_jobid_303s_four_minute_shadow`.
-- `3,18,33,48` misses the FIRING INSTANTS of jobid 302/303 but `:18`/`:48` sit
-- one minute after each 303 firing, which the route's own header records as
-- where 83 of 84 lock timeouts landed: 303 runs a MEDIAN OF 240s, so a
-- minute-level collision check was the wrong check. Live schedule is now
-- `4,24,44`.
--
-- Every 15 minutes, at minutes chosen to avoid the two jobs that touch the same
-- tables: jobid 302 fires at minutes = 2 mod 5 and jobid 303 at 7 mod 10, so
-- 3/18/33/48 collides with neither. `SET statement_timeout` is in the COMMAND,
-- because on pg_cron a function-level SET is INERT; 180s is ~9x the measured
-- 20s pass and still well under the 600s cron_heavy budget.
SELECT cron.schedule(
  'rpc-wmc-fmv-populate-backstop',
  '3,18,33,48 * * * *',
  $cron$SET statement_timeout = '180s'; SELECT public.rpc_wmc_fmv_populate_backstop();$cron$
);

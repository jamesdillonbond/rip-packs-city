-- Schedules expire_allday_dist_opened_drifted() (20260913055000) and corrects one honesty
-- defect in it that the canary exposed before anything was scheduled.
--
-- ⭐ THE CORRECTION: A COOLDOWN TICK WAS REPORTING ok = true, WHICH HIDES THE ONLY FAILURE
-- THIS LANE CAN HAVE. The restore branch fires when the hydrator did not refill an expired
-- row inside p_restore_after — i.e. the upstream Dapper leg is not answering — and that tick
-- correctly reported ok = false. But it then sets a 24-hour cooldown, and every tick inside
-- that window reported `blocked = 'cooldown'`, restored = 0, ok = TRUE. So a dead hydrator
-- showed as ONE not-ok tick followed by twelve green ones, and any no-success arm keyed to
-- this lane would clear while the loop was still broken.
-- ⚠ A cooldown is NEVER a healthy state: it is reachable only after a restore, and a restore
-- is reachable only after the hydrator failed. `ok` now reads
--     (v_restored = 0 AND v_blocked IS DISTINCT FROM 'cooldown')
-- so the lane stays not-ok for as long as it is actually degraded, and the error text names
-- the cooldown case too. ⛔ This does NOT create a permanently-amber arm (the #25 trap): a
-- healthy lane never enters cooldown at all, so the arm is silent whenever the loop works and
-- is continuously red exactly when it does not, which is the distinction this estate keeps
-- paying to get right.
--
-- CANARY, RUN IN PRODUCTION BEFORE THIS MIGRATION — the schedule is not built on an
-- assumption about the upstream, and this is the whole reason the objects and the schedule
-- shipped as two migrations. The hydrator's last proof of life was 2026-09-01, 11 days ago,
-- because its candidate set has been empty since. Two single-row ticks:
--   tick 1 (05:52:26Z): drifted 83, rips_uncounted 306, expired 1 -> dist 7133, pre-image
--                       opened_count 8508, rips_after 76.
--   refill (05:54:01Z): 95 seconds, one hydrator tick. opened_count 8508 -> 8584.
--   ⭐ delta 76 == rips_after 76, EXACTLY. Two independent instruments — Dapper's own
--   count upstream and this repo's captured pack_rips — agree to the unit, which is the
--   same agreement migration 20260901071258's probe found (6877 = 6534 + 343). That is a
--   positive control on THREE things at once: the upstream is alive, the hydrator still
--   refills on the deployed predicate, and the evidence measure is not merely correlated
--   with the drift, it IS the drift.
--   tick 2 (05:55:xxZ): refilled 1, restored 0, drifted 83 -> 82, rips_uncounted 306 -> 230.
--                       Every number reconciles; SETTLE works; the loop closes.
--
-- SCHEDULE: `41 1-23/2 * * *` — every 2 hours at :41 UTC, odd hours only. Drift accrues at
-- ~7.5 dists/day so nothing here is urgent enough to pay hourly for, and the tick's whole read
-- is 2,008 buffers / 505 ms (EXPLAIN ANALYZE, live). Odd hours keep it out of the 06:50-07:30Z
-- band where this instance's saturation spells cluster, and :41 avoids the :00/:15/:30/:45
-- crowd. The default p_limit of 100 clears the 82-dist backlog on the first tick.
--
-- WATCHLIST: allday_pack_supply has never had a cadence arm because it has never had a lane
-- (register #94 exit (2)). 360 min silent / 720 min without success at `medium`: 3x the
-- 120-minute cadence, and the no-success arm now means what it says given the ok correction
-- above. ⚠ Deliberately NOT severity `high` on first deployment — an arm nobody has watched
-- through a full week should not page, and this one can be promoted from the data it collects.
--
-- EXIT / FALSIFIER for the first scheduled tick (unchanged from 20260913055000): expired > 0,
-- then on the following tick refilled == that number with restored = 0 and the drift count
-- falling. If restored > 0 instead, the upstream died between the canary and the tick — the
-- function will already have written the pre-images back and stopped itself; unschedule it.
--
-- REVERT:
--   SELECT cron.unschedule('rpc-allday-dist-opened-expiry');
--   DELETE FROM public.pipeline_cadence_watchlist WHERE pipeline = 'allday-dist-opened-expiry';
--   -- and, to undo the ok correction, re-apply the function body from 20260913055000.
--
-- anon-exec: intentional — no REVOKE here for expire_allday_dist_opened_drifted, because this
-- is a SNAPSHOT/replace migration: CREATE OR REPLACE does not reset a function ACL, so the
-- revoke already made in 20260913055000 (FROM PUBLIC, anon, authenticated; EXECUTE to
-- service_role) still stands and re-issuing it here would be a no-op that reads as a change.
-- Re-verified live AFTER this migration applied, with has_function_privilege rather than acl
-- text: anon EXECUTE false, service_role EXECUTE true, check_secdef_anon_exec_drift() 0 rows.

CREATE OR REPLACE FUNCTION public.expire_allday_dist_opened_drifted(
  p_limit           integer  DEFAULT 100,
  p_restore_after   interval DEFAULT '60 minutes',
  p_retry_cooldown  interval DEFAULT '24 hours'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
SET statement_timeout = '60s'
AS $fn$
DECLARE
  v_allday   constant uuid := 'dee28451-5d62-409e-a1ad-a83f763ac070';  -- nfl_all_day
  v_started  timestamptz := clock_timestamp();
  v_refilled integer := 0;
  v_restored integer := 0;
  v_pending  integer := 0;
  v_expired  integer := 0;
  v_drifted  integer := 0;
  v_rips     bigint  := 0;
  v_blocked  text    := NULL;
  v_result   jsonb;
BEGIN
  -- 1. SETTLE: the hydrator refilled these.
  UPDATE public.allday_dist_opened_expiry e
     SET refilled_at = now()
    FROM public.allday_pack_supply s
   WHERE s.dist_id = e.dist_id
     AND e.refilled_at IS NULL
     AND e.restored_at IS NULL
     AND s.opened_count IS NOT NULL;
  GET DIAGNOSTICS v_refilled = ROW_COUNT;

  -- 2. RESTORE: it did not, inside the window. Put the pre-image back.
  WITH stale AS (
    SELECT e.dist_id, e.opened_count, e.packnft_total, e.opened_updated_at
      FROM public.allday_dist_opened_expiry e
      JOIN public.allday_pack_supply s ON s.dist_id = e.dist_id
     WHERE e.refilled_at IS NULL
       AND e.restored_at IS NULL
       AND e.expired_at < now() - p_restore_after
       AND s.opened_count IS NULL
  ), put_back AS (
    UPDATE public.allday_pack_supply s
       SET opened_count      = st.opened_count,
           packnft_total     = st.packnft_total,
           opened_updated_at = st.opened_updated_at
      FROM stale st
     WHERE st.dist_id = s.dist_id
    RETURNING s.dist_id
  )
  UPDATE public.allday_dist_opened_expiry e
     SET restored_at = now()
    FROM put_back p
   WHERE p.dist_id = e.dist_id;
  GET DIAGNOSTICS v_restored = ROW_COUNT;

  -- 3. BREAKER.
  SELECT count(*) INTO v_pending
    FROM public.allday_dist_opened_expiry
   WHERE refilled_at IS NULL AND restored_at IS NULL;

  IF v_pending > 0 THEN
    v_blocked := 'pending';
  ELSIF EXISTS (SELECT 1 FROM public.allday_dist_opened_expiry
                 WHERE restored_at > now() - p_retry_cooldown) THEN
    v_blocked := 'cooldown';
  END IF;

  -- Drift is measured on EVERY tick, blocked or not, so the pipeline_runs row records the
  -- size of the problem rather than only the size of this tick's bite.
  WITH last_rip AS (
    SELECT r.dist_id, max(r.sealed_at) AS last_sealed
      FROM public.pack_rips r
     WHERE r.collection_id = v_allday
       AND r.sealed_at > (SELECT min(opened_updated_at) FROM public.allday_pack_supply)
       AND r.dist_id IS NOT NULL
     GROUP BY r.dist_id
  )
  SELECT count(*)::int,
         coalesce(sum((SELECT count(*) FROM public.pack_rips r2
                        WHERE r2.collection_id = v_allday
                          AND r2.dist_id = s.dist_id
                          AND r2.sealed_at > s.opened_updated_at)), 0)
    INTO v_drifted, v_rips
    FROM public.allday_pack_supply s
    JOIN last_rip l ON l.dist_id = s.dist_id
   WHERE s.opened_count IS NOT NULL
     AND s.opened_updated_at IS NOT NULL
     AND l.last_sealed > s.opened_updated_at;

  -- 4. EXPIRE.
  IF v_blocked IS NULL AND v_drifted > 0 THEN
    WITH last_rip AS (
      SELECT r.dist_id, max(r.sealed_at) AS last_sealed
        FROM public.pack_rips r
       WHERE r.collection_id = v_allday
         AND r.sealed_at > (SELECT min(opened_updated_at) FROM public.allday_pack_supply)
         AND r.dist_id IS NOT NULL
       GROUP BY r.dist_id
    ), cand AS (
      SELECT s.dist_id, s.opened_count, s.packnft_total, s.opened_updated_at,
             (SELECT count(*) FROM public.pack_rips r2
               WHERE r2.collection_id = v_allday
                 AND r2.dist_id = s.dist_id
                 AND r2.sealed_at > s.opened_updated_at) AS rips_after
        FROM public.allday_pack_supply s
        JOIN last_rip l ON l.dist_id = s.dist_id
       WHERE s.opened_count IS NOT NULL
         AND s.opened_updated_at IS NOT NULL
         AND l.last_sealed > s.opened_updated_at
       ORDER BY rips_after DESC, s.dist_id
       LIMIT GREATEST(p_limit, 1)
    ), snap AS (
      INSERT INTO public.allday_dist_opened_expiry AS x
             (dist_id, opened_count, packnft_total, opened_updated_at, rips_after, expired_at)
      SELECT dist_id, opened_count, packnft_total, opened_updated_at, rips_after, now()
        FROM cand
      ON CONFLICT (dist_id) DO UPDATE SET
        opened_count      = EXCLUDED.opened_count,
        packnft_total     = EXCLUDED.packnft_total,
        opened_updated_at = EXCLUDED.opened_updated_at,
        rips_after        = EXCLUDED.rips_after,
        expired_at        = now(),
        refilled_at       = NULL,
        restored_at       = NULL,
        attempts          = x.attempts + 1
      RETURNING x.dist_id
    )
    UPDATE public.allday_pack_supply s
       SET opened_count = NULL
      FROM snap
     WHERE snap.dist_id = s.dist_id;
    GET DIAGNOSTICS v_expired = ROW_COUNT;
  END IF;

  v_result := jsonb_build_object(
    'drifted', v_drifted, 'rips_uncounted', v_rips, 'expired', v_expired,
    'refilled', v_refilled, 'restored', v_restored, 'pending', v_pending,
    'blocked', v_blocked, 'limit', p_limit);

  -- 5. LOG. NOTE: duration_ms is GENERATED on pipeline_runs -- never list it here.
  INSERT INTO public.pipeline_runs
         (pipeline, collection_slug, started_at, finished_at, rows_found, rows_written, ok, error, extra)
  VALUES ('allday-dist-opened-expiry', 'nfl_all_day', v_started, clock_timestamp(),
          v_drifted, v_expired, (v_restored = 0 AND v_blocked IS DISTINCT FROM 'cooldown'),
          CASE WHEN v_restored > 0
               THEN 'hydrator did not refill ' || v_restored || ' dist(s) within '
                    || p_restore_after::text || ' - pre-images restored, expiry on cooldown'
               WHEN v_blocked = 'cooldown'
               THEN 'expiry held off after a restore: the hydrator is not answering and '
                    || v_drifted || ' dist(s) remain drifted'
          END,
          v_result);

  RETURN v_result;
END;
$fn$;
-- The lane's own cadence arm. allday_pack_supply has had no pipeline_runs row under any
-- name since it was created, so until now nothing on this platform could see it freeze.
INSERT INTO public.pipeline_cadence_watchlist
  (pipeline, severity, is_active, max_silent_minutes, max_minutes_without_success, notes)
VALUES
  ('allday-dist-opened-expiry', 'medium', true, 360, 720,
   'Seeded 2026-09-12 with the lane. Cadence 2h (41 1-23/2 * * *), so 360 = 3x silent and '
   || '720 = 2x that without a success. The no-success arm is meaningful because a cooldown '
   || 'tick reports ok = false: the ONLY way this lane stays not-ok is that the AllDay '
   || 'opened_count hydrator has stopped answering, which is the condition worth waking for. '
   || 'Promote to high after a week of observed cadence if it has not produced a false amber.')
ON CONFLICT (pipeline) DO NOTHING;

SELECT cron.schedule('rpc-allday-dist-opened-expiry', '41 1-23/2 * * *',
                     $job$SELECT public.expire_allday_dist_opened_drifted()$job$);

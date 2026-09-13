-- AllDay pack DEPLETION re-froze the moment the one-shot hydrator finished, exactly as
-- migration 20260901071258's header predicted in writing: "THIS IS A REPAIR, NOT THE FIX.
-- The hydrator will freeze again the moment it finishes."
--
-- MECHANISM (unchanged, re-verified live 2026-09-12 22:4x PT). pg_cron jobid 27
-- `rpc-allday-dist-opened-backfill` calls edge fn `backfill-allday-dist-opened` every 4
-- minutes. Its candidate query is
--     allday_pack_supply.select('dist_id').is('opened_count', null).limit(n)
-- i.e. it selects on the very column it fills, so a row that succeeds leaves the candidate
-- set FOREVER. Measured now: opened_count is non-null on 3,195 of 3,195 rows and
-- opened_updated_at holds exactly TWO distinct days (2026-06-30, the original hydration, and
-- 2026-09-01, the 175-row repair). Every dispatch since 09-01 has returned {"done":true}.
--
-- IMPACT, MEASURED 2026-09-12 22:4x PT — the freeze has already re-accrued in 11 days:
--   83 distributions publish an opened_count that predates 306 pack opens THIS REPO CAPTURED,
--   worst single dist 76 uncounted opens. AllDay is not dormant: 756 rips in 30 days.
-- opened_count feeds v_allday_pack_info.opened_pct_of_minted and, through
-- sync_allday_pack_dist_totals (jobid 75), pack_distributions.total_opened — both public.
--
-- ⭐ WHY THIS IS AN EVIDENCE PREDICATE AND NOT AN AGE WINDOW. The obvious fix (and the one
-- 20260901071258 queued) is a staleness window on opened_updated_at inside the edge function.
-- Two reasons this is the better shape even setting aside that the edge fn is FILELESS (no
-- source in this repo) and carries its gate key as a hardcoded literal in the deployed
-- bundle, which is why that fix was queued for a device-bound session and never done:
--   (1) an age window re-fetches all 3,195 dists forever, the overwhelming majority of which
--       have taken ZERO opens since their stamp — it spends upstream budget to confirm a
--       number that cannot have moved;
--   (2) this repo already has the right shape written down (register #93): "require that the
--       row CAN be priced right now ... self-limiting by construction". The evidence that a
--       dist's opened_count is WRONG is a pack_rips row sealed after its own stamp, and we
--       hold those rows locally. So the candidate set is exactly the wrong rows, it is
--       computed without touching upstream, and it empties itself.
--
-- WHAT THIS DOES, per tick, in order:
--   1. SETTLE  — pending rows the hydrator has refilled are closed out.
--   2. RESTORE — pending rows the hydrator has NOT refilled within p_restore_after get their
--                pre-image written back. This is the dead-upstream safety net: the blank
--                window on a public surface is bounded at p_restore_after even if the
--                upstream never answers again, and the row returns to its last known value
--                rather than staying blank.
--   3. BREAKER — expiry is SKIPPED entirely while anything is pending (the hydrator has not
--                caught up) or while any restore happened inside p_retry_cooldown (the
--                hydrator is failing). So a dead upstream costs ONE batch, once per cooldown,
--                not a growing hole.
--   4. EXPIRE  — up to p_limit drifted dists, worst-drift first, are snapshotted and their
--                opened_count set to NULL, which is the ONLY thing that puts them back into
--                the deployed hydrator's candidate set. No code change, no schedule change to
--                jobid 27, no new object in any read path.
--   5. LOG     — a pipeline_runs row. ⭐ `allday_pack_supply` has never had one under any
--                name (register #94 exit (2), searched over pipeline_runs_daily since 08-01),
--                so until now no cadence arm, no sentinel and no gap detector could see this
--                table freeze at all. That is why the 32-day gap on its supply columns and
--                the 11-day gap here were both found by hand.
--
-- ⚠ ACCEPTED, BOUNDED SIDE EFFECT, inherited from 20260901071258 which measured it: while
-- opened_count is NULL, opened_pct_of_minted reads NULL for that dist (blank, not wrong), and
-- if jobid 75 fires inside the window it copies the NULL into pack_distributions.total_opened,
-- which its next hourly run restores. Exposure is now BOUNDED where it was not before: at most
-- p_limit dists of 3,195, for at most p_restore_after.
--
-- ⚠ ok = false is written ONLY when a restore fired, i.e. the hydrator did not refill inside
-- the window. That is a real failure of the loop and is the signal worth paging on; a tick
-- that finds nothing drifted is ok = true with drifted = 0, and the two are distinguishable
-- in `extra` rather than through rows_written, which this repo books as a null instrument.
--
-- COST, measured with EXPLAIN (ANALYZE, BUFFERS) on the live table 2026-09-12: 2,008 buffers
-- / 505 ms for the drift scan, which is the whole tick's read. The scan is bounded by
-- idx_pack_rips_collection_time_pv (collection_id, sealed_at DESC) over AllDay rips since the
-- oldest stamp — 1,989 rows, not the 3.7M-row table. Scheduled 2-hourly, not hourly: drift
-- accrues at ~7.5 dists/day, so nothing here is urgent enough to pay hourly for.
--
-- EXIT CONDITION / FALSIFIER, both testable within ~15 minutes of the first scheduled tick:
--   EXIT: extra.expired > 0 on the first tick, and on the NEXT tick extra.refilled equals it
--         with extra.restored = 0, and the 83-dist drift count falls.
--   FALSIFIER: extra.restored > 0 on the second tick — the hydrator did not refill, meaning
--         the upstream Dapper leg is no longer alive. The function has then already written
--         the pre-images back by itself and the breaker has stopped it; unschedule the job.
--
-- ⚠ THIS MIGRATION CREATES THE OBJECTS AND DOES NOT SCHEDULE THEM. The pg_cron entry and the
-- cadence-watchlist row ship in a FOLLOW-UP migration, applied only after a canary run
-- (p_limit := 1) has proven in production that the deployed hydrator still refills an expired
-- row — i.e. that the upstream Dapper leg is alive. Its last proof of life is 2026-09-01; the
-- candidate set has been empty since, so nothing has exercised it in 11 days and a schedule
-- built on the assumption would be a schedule that blanks rows nothing refills.
--
-- REVERT (in this order):
--   SELECT cron.unschedule('rpc-allday-dist-opened-expiry');   -- if the follow-up was applied
--   UPDATE public.allday_pack_supply s
--      SET opened_count = e.opened_count, packnft_total = e.packnft_total,
--          opened_updated_at = e.opened_updated_at
--     FROM public.allday_dist_opened_expiry e
--    WHERE e.dist_id = s.dist_id AND s.opened_count IS NULL;
--   DROP FUNCTION public.expire_allday_dist_opened_drifted(integer, interval, interval);
--   DROP TABLE public.allday_dist_opened_expiry;
--   DELETE FROM public.pipeline_cadence_watchlist WHERE pipeline = 'allday-dist-opened-expiry';
--   -- the column COMMENTs below are documentation of existing behaviour; leave them.
--
-- anon-exec: the new function is SECURITY DEFINER and is revoked from PUBLIC/anon/authenticated
-- and granted to service_role only, matching rollup_pipeline_gaps. pg_cron calls it as the job
-- owner (postgres), which owns the function, so the revoke cannot orphan the caller.

-- ---------------------------------------------------------------------------------------
-- 1. The pre-image / state table. Durable (not an audit_ one-shot): the restore path reads it.
-- ---------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.allday_dist_opened_expiry (
  dist_id           text PRIMARY KEY,
  opened_count      bigint,
  packnft_total     bigint,
  opened_updated_at timestamptz,
  rips_after        bigint,
  expired_at        timestamptz NOT NULL DEFAULT now(),
  refilled_at       timestamptz,
  restored_at       timestamptz,
  attempts          integer NOT NULL DEFAULT 1
);

COMMENT ON TABLE public.allday_dist_opened_expiry IS
  'Pre-image + state for expire_allday_dist_opened_drifted(). One row per dist ever expired. '
  'refilled_at set when the hydrator re-counted it; restored_at set when it did NOT and the '
  'pre-image was written back. A row with both NULL is in flight.';

ALTER TABLE public.allday_dist_opened_expiry ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.allday_dist_opened_expiry FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.allday_dist_opened_expiry TO service_role;

-- ---------------------------------------------------------------------------------------
-- 2. Document the two stamps on allday_pack_supply (register #94 exit (3)).
--    Established from the WRITER, not guessed: supabase/functions/backfill-allday-pack-supply
--    builds each row with `supply_ok: true, updated_at: now()` and upserts ONLY on a
--    successful page; a failed page increments pageErrs and writes nothing. Live check
--    2026-09-12: 0 of 3,195 rows have supply_ok <> true. So unlike topshot_pack_supply — where
--    updated_at is a TRY stamp and last_success_at is the KNOW stamp, a distinction that cost
--    an investigation — both stamps here are know-stamps, and no last_success_at is needed.
-- ---------------------------------------------------------------------------------------
COMMENT ON COLUMN public.allday_pack_supply.updated_at IS
  'KNOW-stamp for the SUPPLY columns (total_minted, pack_price, pack_odds, slots, title, '
  'edition_ids): the writer upserts only on a successful upstream page, so this moves only '
  'when we last KNEW, never merely when we last tried. Does NOT cover opened_count — that '
  'has its own stamp, opened_updated_at.';

COMMENT ON COLUMN public.allday_pack_supply.opened_updated_at IS
  'KNOW-stamp for opened_count only, written by edge fn backfill-allday-dist-opened. Kept '
  'intact while opened_count is NULLed by expire_allday_dist_opened_drifted(), so the restore '
  'path and any age reader still resolve during the refetch window.';

COMMENT ON COLUMN public.allday_pack_supply.supply_ok IS
  'Always true in practice: the writer upserts only on success and never records a failure row '
  '(0 of 3,195 non-true, 2026-09-12). NOT the honest-failure column its topshot_pack_supply '
  'namesake is — a failed fetch here leaves the PRIOR row untouched rather than marking it.';

-- ---------------------------------------------------------------------------------------
-- 3. The lane.
-- ---------------------------------------------------------------------------------------
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
          v_drifted, v_expired, (v_restored = 0),
          CASE WHEN v_restored > 0
               THEN 'hydrator did not refill ' || v_restored || ' dist(s) within '
                    || p_restore_after::text || ' - pre-images restored, expiry on cooldown'
          END,
          v_result);

  RETURN v_result;
END;
$fn$;

REVOKE ALL ON FUNCTION public.expire_allday_dist_opened_drifted(integer, interval, interval)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.expire_allday_dist_opened_drifted(integer, interval, interval)
  TO service_role;

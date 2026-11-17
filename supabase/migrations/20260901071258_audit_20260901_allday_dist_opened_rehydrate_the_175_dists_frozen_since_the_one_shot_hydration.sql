-- AllDay pack DEPLETION has been frozen for 63 days on 175 distributions.
--
-- MECHANISM (established 2026-09-01 07:0xZ, not inferred).
-- pg_cron jobid 27 `rpc-allday-dist-opened-backfill` calls edge fn
-- `backfill-allday-dist-opened` every 4 minutes. Its candidate query is
--     allday_pack_supply.select('dist_id').is('opened_count', null).limit(n)
-- i.e. it selects on the very column it then fills. It is a ONE-SHOT HYDRATOR,
-- not a refresher: there is no staleness window on opened_updated_at and no
-- re-walk path (the documented `?after=` cursor is read into a variable and
-- never used). Every row was hydrated in a single 2h window on 2026-06-30
-- (02:16:52Z .. 04:20:21Z, measured). Since then the candidate set has been
-- empty and every one of ~22,700 dispatches has returned {"done":true}.
-- It writes NO pipeline_runs row, so nothing watched the silence.
--
-- IMPACT, MEASURED. 175 distributions have taken 1,656 pack opens since their
-- own opened_updated_at (AllDay is NOT dormant: 900 rips in August, 14 in
-- September, newest 2026-09-01 06:01Z). opened_count feeds
-- v_allday_pack_info.opened_pct_of_minted and, through
-- sync_allday_pack_dist_totals (jobid 75), pack_distributions.total_opened --
-- both public. Worst case dist_id 6369: published 93.4% depleted, true 98.3%.
--
-- POSITIVE CONTROL (why this is safe to re-null). The function's own
-- ?mode=probe path was called against dist 6369 at 07:11:19Z and returned
-- {"opened":{"ok":true,"total":6877},"total":{"ok":true,"total":6999}} -- the
-- upstream Dapper leg is ALIVE, and 6877 equals the stored 6534 plus the 343
-- rips this repo captured since the freeze, so the two instruments agree
-- exactly. packnft_total is unchanged (6999 = 6999): minted really is frozen,
-- only OPENS moved.
--
-- WHAT THIS DOES. Snapshots the 175 rows, then sets their opened_count to NULL
-- so the already-deployed job re-counts them from upstream on its own next
-- ticks. No code change, no schedule change, no new object in the read path.
-- The rows are re-filled within ~2 ticks (n=100 default, 4-minute cadence).
--
-- ⚠ ACCEPTED, BOUNDED SIDE EFFECT: while opened_count is NULL,
-- opened_pct_of_minted reads NULL for those dists (blank, not wrong), and if
-- jobid 75 fires inside the window it copies the NULL into
-- pack_distributions.total_opened, which its next hourly run restores.
--
-- ⛔ THIS IS A REPAIR, NOT THE FIX. The hydrator will freeze again the moment
-- it finishes. The permanent fix is to change its candidate predicate from
-- `opened_count IS NULL` to a staleness window on opened_updated_at -- an edge
-- function redeploy, which this session cannot do safely because the gate key
-- is a hardcoded literal in the deployed source rather than an env secret.
-- Queued for Trevor / a device-bound session.
--
-- EXIT CONDITION, from the measurement just taken: within 15 minutes every one
-- of the 175 rows has a non-null opened_count with opened_updated_at > the
-- apply time, and sum(opened_count) over them has risen by ~1,656.
-- FALSIFIER: if any row is still NULL 30 minutes after apply, the upstream leg
-- failed after the probe -- restore from the snapshot immediately.
--
-- REVERT (restores the exact pre-image, one statement):
--   UPDATE public.allday_pack_supply s
--      SET opened_count = a.opened_count, opened_updated_at = a.opened_updated_at
--     FROM public.audit_20260901_allday_dist_opened_prefreeze a
--    WHERE a.dist_id = s.dist_id;
--   DROP TABLE public.audit_20260901_allday_dist_opened_prefreeze;
--
-- anon-exec: n/a -- this migration creates no function. The new audit table is
-- RLS-enabled with no policies and revoked from anon/authenticated, matching
-- the service-role posture of every other audit_ table.

CREATE TABLE IF NOT EXISTS public.audit_20260901_allday_dist_opened_prefreeze (
  dist_id            text PRIMARY KEY,
  opened_count       bigint,
  packnft_total      bigint,
  opened_updated_at  timestamptz,
  rips_after         bigint,
  snapshotted_at     timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.audit_20260901_allday_dist_opened_prefreeze ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_20260901_allday_dist_opened_prefreeze FROM anon, authenticated;

INSERT INTO public.audit_20260901_allday_dist_opened_prefreeze
      (dist_id, opened_count, packnft_total, opened_updated_at, rips_after)
SELECT s.dist_id, s.opened_count, s.packnft_total, s.opened_updated_at,
       (SELECT count(*) FROM public.pack_rips r
         WHERE r.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'
           AND r.dist_id = s.dist_id
           AND r.sealed_at > s.opened_updated_at)
  FROM public.allday_pack_supply s
 WHERE s.opened_count IS NOT NULL
   AND s.opened_updated_at IS NOT NULL
   AND EXISTS (SELECT 1 FROM public.pack_rips r
                WHERE r.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'
                  AND r.dist_id = s.dist_id
                  AND r.sealed_at > s.opened_updated_at)
ON CONFLICT (dist_id) DO NOTHING;

DO $$
DECLARE v_snap int; v_nulled int;
BEGIN
  SELECT count(*) INTO v_snap FROM public.audit_20260901_allday_dist_opened_prefreeze;
  IF v_snap NOT BETWEEN 100 AND 400 THEN
    RAISE EXCEPTION 'snapshot size % is outside the measured band (175 at 07:11Z); refusing to null anything', v_snap;
  END IF;

  UPDATE public.allday_pack_supply s
     SET opened_count = NULL
    FROM public.audit_20260901_allday_dist_opened_prefreeze a
   WHERE a.dist_id = s.dist_id;
  GET DIAGNOSTICS v_nulled = ROW_COUNT;

  IF v_nulled <> v_snap THEN
    RAISE EXCEPTION 'nulled % rows but snapshotted % -- aborting', v_nulled, v_snap;
  END IF;

  RAISE NOTICE 'snapshotted and nulled % dists for re-hydration', v_nulled;
END $$;
-- audit_20261120_zero_yield_candy_orphan_name_only_drained
--
-- 2026-11-20 ~4:35 PM PT (Claude Code cloud; Trevor: "work autonomously ... fix any issues you encounter").
--
-- check_zero_yield_lanes() names one offender: candy-orphan-name-only-editions (pg_cron
-- rpc-candy-orphan-name-only-editions, hourly at :37; 168 runs in 7 days, all ok, last find 11-13).
-- It is a DRAINED CLEANUP, not a stall. It deletes Candy NAME-ONLY editions (tier, player_name,
-- thumbnail_url NULL and circulation 0/NULL) once no card holds them (20261110044500, #246). It
-- deleted 1,930 / 2,116 / 237 / 281 on 11-10..11-13 and 0 every day since. Measured now: the WHOLE
-- name-only population (held or not, any age) = 0, not merely the unheld part, so there is nothing
-- left for it to find. Positive control: the census is live — 58 Candy editions were created in the
-- last 7 days, none of them name-only (the census fetches metadata before keying a card since
-- 28720979f, so it does not re-create this shape).
--
-- The job is KEPT (cheap safety net). This row only stops the Zero-Yield arm reporting a finished
-- backlog as a dead lane.
--
-- REVERT:
--   DELETE FROM public.pipeline_zero_yield_suppressions WHERE pipeline = 'candy-orphan-name-only-editions';

DO $mig$
DECLARE v_name_only int; v_runs int; v_fail int;
BEGIN
  SELECT count(*) INTO v_name_only FROM public.editions e
   WHERE e.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'
     AND e.tier IS NULL AND e.player_name IS NULL AND e.thumbnail_url IS NULL
     AND coalesce(e.circulation_count, 0) = 0;
  IF v_name_only <> 0 THEN
    RAISE EXCEPTION 'premise false: % Candy name-only editions exist — not a drained lane', v_name_only;
  END IF;
  SELECT count(*), count(*) FILTER (WHERE NOT ok) INTO v_runs, v_fail
    FROM public.pipeline_runs
   WHERE pipeline = 'candy-orphan-name-only-editions' AND started_at > now() - interval '24 hours';
  IF v_runs < 20 THEN
    RAISE EXCEPTION 'premise false: only % runs in 24 h (expected ~24)', v_runs;
  END IF;
  IF v_fail <> 0 THEN
    RAISE EXCEPTION 'premise false: % failed runs in 24 h', v_fail;
  END IF;
END
$mig$;

INSERT INTO public.pipeline_zero_yield_suppressions (pipeline, reason, added_by) VALUES
('candy-orphan-name-only-editions',
 'DRAINED CLEANUP, measured 2026-11-20 ~4:35 PM PT. It deletes Candy name-only editions (tier, player_name, thumbnail_url NULL, circulation 0/NULL) once unheld (#246). Deleted 4,564 on 11-10..11-13, 0 since. The WHOLE name-only population (held or unheld) = 0. Positive control: 58 Candy editions created in the last 7 days, none name-only, so the census is live and no longer creates this shape. RE-CHECK CONDITION: remove this row if any Candy name-only edition exists for more than a day (the census re-created the shape) while rows_found stays 0, or if extra.referenced > 0.',
 'claude-code-cloud session_014vX7Q7E93tPGfbBRDcTDZb')
ON CONFLICT (pipeline) DO UPDATE SET reason = EXCLUDED.reason, added_by = EXCLUDED.added_by;

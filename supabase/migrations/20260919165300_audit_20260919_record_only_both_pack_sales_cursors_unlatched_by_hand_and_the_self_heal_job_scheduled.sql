-- audit_20260919_record_only_both_pack_sales_cursors_unlatched_and_job_scheduled
--
-- RECORD-ONLY. Two `execute_sql` data/pg_cron changes, neither of which writes a
-- row to `supabase_migrations.schema_migrations`. This file is the repo's copy of
-- what happened and how to undo it. (Precedent: `20260826063100`.)
--
-- ── 1. THE UNLATCH (data), 2026-09-19 ~16:40Z and ~16:44Z ─────────────────────
-- Both pack-sales cursors were sitting on a terminal `done = true` and had been
-- for days, so `backfill-topshot-pack-sales` / `backfill-allday-pack-sales`
-- returned `{"done":true}` and did nothing on every one of ~960 dispatches/day.
-- Diagnosis and mechanism: `20260919164919`.
--
--   UPDATE public.topshot_pack_sales_cursor
--      SET after_cursor = NULL, done = false, total_seen = 0, updated_at = now()
--    WHERE id = 1;     -- applied 16:40:05Z
--   UPDATE public.allday_pack_sales_cursor
--      SET after_cursor = NULL, done = false, total_seen = 0, updated_at = now()
--    WHERE id = 1;     -- applied ~16:44Z
--
-- ⭐ TOP SHOT WAS RESET FIRST AND ALONE, ON PURPOSE -- ALL DAY WAS THE CONTROL.
-- Both lanes were dead in the same way, so releasing one and holding the other
-- for four minutes gave a no-change control the fix could not move, and both
-- sides were counted by the SAME query. Measured at 16:42Z:
--
--   lane                     newest_sale               touched_15m   new_sales
--   topshot (reset)          09-13 12:59 -> 09-19 15:19      1,288       1,187
--   allday  (control, held)  09-12 02:15  (unmoved)              0           0
--
-- All Day was then released and reached `09-17 15:49` (its market is thin --
-- 1-17 rows/day -- so a 2-day-old newest sale there is plausible, not a second
-- fault; that is why it could not have served as the POSITIVE leg).
--
-- ── 2. THE SELF-HEAL SCHEDULE (pg_cron), 16:49Z ───────────────────────────────
--   SELECT cron.schedule('rpc-pack-sales-cursor-unlatch',
--                        '3,13,23,33,43,53 * * * *',
--                        $$SELECT public.unlatch_pack_sales_cursors(30);$$);
--   -- assigned jobid 526, owner `postgres`
-- Minutes are deliberately off :00/:15/:30/:45 -- `max_worker_processes = 6`
-- against `cron.max_running_jobs = 32` makes the round minutes a live
-- worker-slot starvation source on this box.
--
-- ── REVERT ────────────────────────────────────────────────────────────────────
--   SELECT cron.unschedule('rpc-pack-sales-cursor-unlatch');
-- The cursor UPDATEs are not meaningfully revertible and should not be reverted
-- (the prior state was a dead latch); the exact pre-fix values are recorded in
-- `20260919164919` if they are ever needed forensically.

DO $$
DECLARE
  v_sched text;
  v_ts_done boolean;
  v_ad_done boolean;
BEGIN
  SELECT schedule INTO v_sched FROM cron.job WHERE jobname = 'rpc-pack-sales-cursor-unlatch';

  IF v_sched IS NULL THEN
    -- A WARNING, not an exception: on a fresh database rebuilt from migrations
    -- there is no pg_cron estate at all, and a hard failure there would make the
    -- whole history unreplayable for a reason that is not a defect.
    RAISE WARNING 'rpc-pack-sales-cursor-unlatch is not scheduled -- the pack-sales '
                  'lanes have no self-heal and will re-latch silently (see 20260919164919)';
  END IF;

  -- ⚠ This asserts the PROPERTY the fix exists for -- that neither cursor is
  -- sitting latched right now -- rather than the schedule string, so a later
  -- re-stagger does not red this for no reason.
  SELECT done INTO v_ts_done FROM public.topshot_pack_sales_cursor WHERE id = 1;
  SELECT done INTO v_ad_done FROM public.allday_pack_sales_cursor  WHERE id = 1;
  IF coalesce(v_ts_done, false) OR coalesce(v_ad_done, false) THEN
    RAISE WARNING 'a pack-sales cursor is currently done=true (topshot=%, allday=%) -- '
                  'expected transiently at a lap boundary, but if it persists past 30 min '
                  'the self-heal job is not running', v_ts_done, v_ad_done;
  END IF;
END $$;

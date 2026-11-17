-- Third and last pack_rips entry tonight. Even at 50 credits / 50 ms (20260920032539) the
-- throttled pass coincided with SEVEN more `job startup timeout` rows at 8:30 PM PT and
-- IO-waiting 10 of 12 active backends — attribution is shared with the tail of the earlier
-- spells and a routine cached_listings autovacuum, but the honest reading is that the index
-- pass (1.28 GB, 11 indexes on a 764 MB heap) is the cost and pacing only spreads it. The
-- 66.7 % map is a week-old status quo, not an incident; another ten minutes of failed lanes
-- to fix it at 8:30 PM on a Saturday is the wrong trade for users.
--
-- So: autovacuum on pack_rips is PAUSED now (the ALTER cancels the running pass — the same
-- SHARE UPDATE EXCLUSIVE rule — and the trigger cannot re-fire while disabled), and a one-off
-- pg_cron job re-enables it at 08:12Z = 1:12 AM PT, inside the measured quietest hour of the
-- day (7-day cron busy-seconds by UTC hour: 09Z 3,085 s/day, 08Z 3,140, 10Z 3,227 vs 3,500–
-- 7,000+ elsewhere; 3–4 failures/day in that band). The job unschedules itself in the same
-- command (ALTER TABLE tolerates the implicit transaction; VACUUM would not). The throttle
-- (50/50) and the 0.02 trigger stay, so the pass runs paced, in the quiet hour, once — after
-- that the map is clean and subsequent passes are incremental.
-- Applied from Cowork cloud 2026-09-19 8:33 PM PT (jobid 560). ⚠ That session's push tooling
-- is its own concern; this file commits as usual.
--
-- EXIT: by ~1:30 AM PT 09-20, pack_rips autovacuum_count = 3 and relallvisible/relpages > 95 %;
-- cron.job holds no 'rpc-oneoff-pack-rips-autovacuum-reenable' row; the 08Z–09Z failure count
-- for 09-20 is within its 3–4/day band.
-- FALSIFIER: a startup-timeout step at 1:13–1:30 AM PT anyway ⇒ the index pass is the cost at
-- any pace and the lever is index count on pack_rips (register item to open).
-- REVERT: ALTER TABLE public.pack_rips RESET (autovacuum_enabled);
--         SELECT cron.unschedule('rpc-oneoff-pack-rips-autovacuum-reenable');

ALTER TABLE public.pack_rips SET (autovacuum_enabled = false);

SELECT cron.schedule(
  'rpc-oneoff-pack-rips-autovacuum-reenable',
  '12 8 * * *',
  $cmd$ALTER TABLE public.pack_rips SET (autovacuum_enabled = true); SELECT cron.unschedule('rpc-oneoff-pack-rips-autovacuum-reenable');$cmd$
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class c, unnest(c.reloptions) o WHERE c.oid = 'public.pack_rips'::regclass AND o = 'autovacuum_enabled=false') THEN
    RAISE EXCEPTION 'pause not applied';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'rpc-oneoff-pack-rips-autovacuum-reenable' AND username = 'postgres') THEN
    RAISE EXCEPTION 're-enable job not scheduled as postgres';
  END IF;
END $$;

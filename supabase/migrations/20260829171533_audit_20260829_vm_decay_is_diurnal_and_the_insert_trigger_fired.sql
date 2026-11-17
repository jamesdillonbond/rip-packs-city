-- audit_20260829_vm_decay_is_diurnal_and_the_insert_trigger_fired
--
-- Metadata only. APPENDS a dated section to the public.sales_2026 table comment.
-- No storage parameters, no autovacuum knobs, no grants, no data. The previous
-- section (20260829150941) ends on a verdict that this pass's measurements change,
-- and three passes have now re-derived a wrong verdict about this table from a
-- stale note; leaving the current last word unchallenged is what produces a fourth.
--
-- Guards: PRE-STATE md5 assertion (so a concurrent edit is never clobbered) and a
-- post-state readback that re-checks the pre-image survives at the head.
--
-- REVERT (the guard makes it a truncation):
--   DO $r$ DECLARE c text; BEGIN
--     SELECT obj_description('public.sales_2026'::regclass,'pg_class') INTO c;
--     EXECUTE format('COMMENT ON TABLE public.sales_2026 IS %L', left(c, 9848));
--   END $r$;

DO $mig$
DECLARE
  v_old  text;
  v_new  text;
  v_read text;
  c_md5  constant text := '781bc12a38cc9ef7bd96f196c944a517';
  c_len  constant int  := 9848;
BEGIN
  SET LOCAL lock_timeout = '5s';

  v_old := obj_description('public.sales_2026'::regclass, 'pg_class');
  IF v_old IS NULL THEN
    RAISE EXCEPTION 'PRE-STATE FAILED: public.sales_2026 carries no comment';
  END IF;
  IF length(v_old) <> c_len OR md5(v_old) <> c_md5 THEN
    RAISE EXCEPTION
      'PRE-STATE FAILED: comment is not the 20260829150941 text (len % md5 %, expected % / %) -- '
      'a concurrent session edited it; re-read before appending',
      length(v_old), md5(v_old), c_len, c_md5;
  END IF;

  v_new := v_old || '

=== 2026-08-29 17:1xZ (10:1x PT) -- THE INSERT TRIGGER DID FIRE AND DID CLEAR THE MAP; THE DECAY
=== RATE IS DIURNAL; AND THE THING THIS WHOLE THREAD WAS PROTECTING TURNS OUT NOT TO NEED IT
(Cowork cloud pass, ~2 h after the section above. Nothing above is retracted. What is ADDED is a
 completed autovacuum cycle, a second decay anchor, and one control that changes the STAKES.)

--- 1. THE 1500 INSERT THRESHOLD FIRED, AND IT WORKS. ---
pg_stat_all_tables.last_autovacuum on this table = 2026-08-29 15:45:02.483Z, autovacuum_count
11 -> 12. That is the FIRST firing of the threshold 20260829111140 installed at 11:11Z. It landed
30 minutes after the section above was written, and 4.25 h EARLIER than that section predicted
("around 20:00Z tonight").
  15:08:00Z   Heap Fetches 16,806   (falsifier met)
  15:45:02Z   AUTOVACUUM
  17:01:50Z   Heap Fetches  2,248   Buffers 15,241
  17:14:06Z   Heap Fetches  3,389   Buffers 15,964
=> An insert-triggered autovacuum DOES reset this map. The section above called the 11:11Z change
   "insufficient"; the accurate word is MIS-KEYED, not ineffective. It fires, and when it fires it
   works. n_dead_tup went 3,161 -> 92.

--- 2. THE DECAY RATE IS DIURNAL, AND THAT IS THE FINDING THAT SETTLES THE KNOB ARGUMENT. ---
Both anchors below are measured from a KNOWN vacuum event, so neither is a short-window burst
figure (unlike the 15:00->15:08Z interval, which this table''s own caveat above tells you not to
promote):
    cycle A, from the 00:22:38Z manual VACUUM:   +6.7 h -> 3,363   =>   ~502 Heap Fetches/h
    cycle B, from the 15:45:02Z autovacuum:      +1.28 h -> 2,248  => ~1,757/h
                                                 +1.49 h -> 3,389  => ~2,277/h
THE SAME TABLE DECAYS ~4.5x FASTER IN THE AFTERNOON THAN IT DOES OVERNIGHT. That matches the
mechanism the section above established -- scattered UPDATEs, not inserts -- because the update
rate is diurnal and the insert rate is comparatively flat.
CONSEQUENCE, and it is the whole argument in one line:
  * the 10,000 falsifier is crossed at roughly +20 h overnight but at roughly +4 to +5 h in the
    afternoon;
  * the 1500-insert trigger''s observed post-vacuum refill rate is ~79 inserts/h
    (n_ins_since_vacuum 103 at 17:03Z, 78 min after the 15:45Z vacuum), i.e. it next fires in
    ROUGHLY 19 h.
  => An INSERT-keyed trigger is slowest exactly when the decay is fastest. It is anticorrelated
     with need, by construction. No value of the insert threshold fixes that -- which is a
     STRONGER reason not to re-tune it than the one recorded above, and it is not a fitted ratio.
  => autovacuum_vacuum_scale_factor is keyed on DEAD TUPLES, which updates produce, so it
     self-adjusts with the diurnal driver. That, and not "it is more aggressive", is the case for
     it. STILL NOT SHIPPED HERE -- the ledger''s open wallet_moments_cache hypothesis against
     aggressive scale factors on this instance is unresolved, and it is an IO-budget change on this
     instance''s binding constraint. Trevor''s call, unchanged. Revert if taken:
     ALTER TABLE public.sales_2026 SET (autovacuum_vacuum_scale_factor = 0.05);

--- 3. *** THE STAKES ARE LOWER THAN THIS THREAD HAS BEEN ASSUMING. READ THIS BEFORE ESCALATING. ***
This whole thread exists because c26ae1981 fixed /api/analytics/sales/leaderboard by driving Heap
Fetches on this table to 0, so map rot read as a user-facing regression waiting to happen.
MEASURED TODAY, AND IT REFUTES THAT FRAMING: a ten-wide leaderboard sweep at 16:53:25-16:53:44Z
(5 collections x 2 roles) failed 10 OF 10 on statement timeout -- 68 minutes AFTER the 15:45Z
autovacuum, with the map at 2,248 Heap Fetches, the FRESHEST reading on record for this table
today and lower than the 3,363 measured 6.7 h after the manual VACUUM.
=> THE LEADERBOARD FAILS WITH THE MAP FRESH. Vacuuming this table is NOT what stands between users
   and that route; the ten-wide concurrency is. Full working, with the independent-instrument
   corroboration and the pg_cron convergence, is in the comment on
   public.analytics_sales_leaderboard (20260829171156).
=> SO: re-scope this thread from "user-facing incident hedge" to "IO hygiene on the hot partition",
   and weigh BOTH queued decisions -- repairing jobid 380, and the scale factor -- at that lower
   stake. Do not escalate either one on leaderboard grounds. The lever that carries the user impact
   is the COLLECTION PUSH-DOWN, and it belongs to whoever holds git.

--- 4. jobid 380: HALF THE REPAIR IS NOW SHIPPED. ---
The section above is CORRECT that repairing jobid 380 needs both a GRANT MAINTAIN to cron_heavy and
an unschedule+reschedule under SET LOCAL ROLE cron_heavy. Migration 20260829170822 has shipped THE
GRANT ONLY (revert: REVOKE MAINTAIN ON TABLE public.sales_2026 FROM cron_heavy). It is
behaviour-neutral today -- no cron_heavy job references this table -- and it exists so the remaining
half is a SINGLE safe statement pair rather than an ordered pair in which one order produces a job
that skips the VACUUM and reports "succeeded".
CONFIRMED, so nobody re-derives it: jobid 380''s cron.job.username is postgres;
has_table_privilege(''postgres'', ''public.sales_2026'', ''MAINTAIN'') is TRUE; pg_roles.rolconfig for
postgres carries NO statement_timeout, so it inherits the cluster''s 120 s; the single run at
2026-08-29 10:20:00.386Z was cancelled at 120.08 s "while scanning relation public.sales_2026".
A missing MAINTAIN was never the cause -- it is only a hazard of the FIX.
AND NOTE THE CADENCE POINT THAT FALLS OUT OF SECTION 2: a daily 10:20Z vacuum was already the wrong
shape, and the diurnal finding says so more sharply -- 10:20Z UTC is 03:20 PT, i.e. it would land at
the START of the slow overnight decay and leave the fast afternoon decay uncovered. If the job is
repaired, the slot wants re-choosing on this evidence, not kept.';

  EXECUTE format('COMMENT ON TABLE public.sales_2026 IS %L', v_new);

  v_read := obj_description('public.sales_2026'::regclass, 'pg_class');
  IF v_read IS NULL OR v_read <> v_new THEN
    RAISE EXCEPTION 'POST-STATE FAILED: readback does not match what was written';
  END IF;
  IF left(v_read, c_len) <> v_old THEN
    RAISE EXCEPTION 'POST-STATE FAILED: the pre-image was damaged by the append';
  END IF;
END
$mig$;

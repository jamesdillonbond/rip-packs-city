-- audit_20260829_sales_2026_vm_falsifier_met_and_inserts_are_not_the_driver
--
-- WHAT: appends a dated section to the public.sales_2026 table comment installed by
--       migration 20260829070701. Metadata only. No DDL on the table, no storage
--       parameter change, no data touched, no grants, no signatures.
--
-- WHY:  the comment currently ends on a verdict that is now FALSE ("the daily 10:20Z
--       vacuum looks adequate WITH margin", "FALSIFIER NOT MET at +6.7 h"). Three
--       readings on 2026-08-29 cross the registered ~10,000 Heap Fetches line. Leaving
--       the old verdict as the last word invites the next pass to re-derive it.
--
-- REVERT (restores the exact pre-migration comment, whose md5 is asserted below):
--   the pre-image is the comment installed by 20260829070701; to revert, re-apply that
--   migration's COMMENT ON TABLE body. The guard here asserts md5
--   da0daf458a67ced55fe907bf07a75c04 / length 3891 before appending, so a revert is
--   "truncate the comment back to its first 3891 characters":
--     DO $r$ DECLARE c text; BEGIN
--       SELECT obj_description('public.sales_2026'::regclass,'pg_class') INTO c;
--       EXECUTE format('COMMENT ON TABLE public.sales_2026 IS %L', left(c, 3891));
--     END $r$;
--
-- Scope note: authored by a Cowork cloud session that cannot push. That blocker is
-- specific to this cloud session. Trevor's machine and Claude Code push normally via
-- the PAT in remote.origin.pushurl. Commit this file as usual.

DO $mig$
DECLARE
  v_before text;
  v_check  text;
  v_add    text;
BEGIN
  SET LOCAL lock_timeout = '5s';

  SELECT obj_description('public.sales_2026'::regclass, 'pg_class') INTO v_before;

  IF v_before IS NULL THEN
    RAISE EXCEPTION 'pre-state mismatch: public.sales_2026 carries no comment; expected the one installed by 20260829070701';
  END IF;

  IF md5(v_before) <> 'da0daf458a67ced55fe907bf07a75c04' THEN
    RAISE EXCEPTION 'pre-state mismatch: comment md5 is % (length %), expected da0daf458a67ced55fe907bf07a75c04 (length 3891). Something edited it since 15:08Z 2026-08-29 -- re-read and re-derive before appending.',
      md5(v_before), length(v_before);
  END IF;

  v_add := $txt$

=== 2026-08-29 15:0xZ (08:0x PT) -- THE FALSIFIER IS MET, AND INSERTS ARE NOT THE DRIVER ===
(Cowork cloud pass. Everything above this line was written at 07:07Z and its VERDICT is now
 SUPERSEDED. The instrument trap it records -- relallvisible is a frozen statistic -- still holds
 and is still correct. What is retracted is only "the daily 10:20Z vacuum looks adequate WITH
 margin" and "FALSIFIER NOT MET".)

THE FALSIFIER REGISTERED IN 20260829002812 -- Heap Fetches on this scan back above ~10,000 -- IS
MET. Same shape-matched probe as above, single process, collection pinned:

  EXPLAIN (ANALYZE, BUFFERS)
  SELECT count(*) FROM public.sales_2026
  WHERE collection = 'nba_top_shot' AND sold_at >= now() - interval '30 days';

  time (Z)   h since 00:22:38Z VACUUM   Heap Fetches   interval rate
  07:05          +6.7                        3,363      --
  11:12         +10.9                        5,793        590/h
  15:00         +14.6                       15,416      2,533/h
  15:08         +14.8                       16,806      burst, see below

  The line was crossed somewhere between 11:12Z and 15:00Z, i.e. ~12-14 h after a VACUUM.

REPRODUCED, NOT A ONE-OFF. The 15:00Z reading was run TWICE back to back and returned Heap
Fetches 15,416 and Buffers 23,813 BOTH TIMES, while Execution Time moved 2,153 ms -> 46 ms
(cold vs cached). Instance was quiet at the time: 34 backends, 1 active, 0 in IO wait, 0 queries
over 60 s. So this is not a saturation artifact, and it is one more demonstration that on this
table BUFFERS AND HEAP FETCHES ARE THE DURABLE FIGURES AND TIMINGS ARE NOT.

*** INSERTS ARE NOT THE DRIVER, AND THAT REFUTES THE SIZING BASIS OF 20260829111140. ***
Between the 15:00Z and 15:08Z probes the scan's row count moved 116,748 -> 116,758 -- TEN new
rows -- while Heap Fetches moved 15,416 -> 16,806, i.e. +1,390. Ten inserts cannot make 1,390
rows not-all-visible.
Direct counter read over 15:02:26Z -> 15:07:00Z (4.57 min; SHORT WINDOW, stated as such):
  n_tup_upd  100,955 -> 101,055   (+100)  ~1,312/h    <-- 5.3x the inserts
  n_tup_ins  152,295 -> 152,314   ( +19)  ~  249/h
  n_tup_hot_upd 21,810 -> 21,875  ( +65)  65% of updates are HOT
  n_dead_tup  3,120 -> 3,161
Scattered UPDATEs, not inserts, are what takes pages off the all-visible map here.

WHAT THAT MEANS FOR THE KNOB THAT WAS TURNED AT 11:11Z. 20260829111140 set
autovacuum_vacuum_insert_threshold 2000 -> 1500 with insert_scale_factor 0, sized on a measured
5.2 Heap Fetches per insert. The same coefficient measured over 11:12Z -> 15:00Z is 55.6 per
insert, and over 15:00Z -> 15:08Z it is 139 per insert. The coefficient is not stable because it
is not a coefficient -- it is a ratio between two independent rates. THE CHANGE IS NOT HARMFUL
(1500 is strictly more frequent than the 2000 it replaced) BUT IT CANNOT GOVERN THIS DECAY:
at the observed insert rate of ~45-250/h, a 1500-insert trigger fires every ~6-33 h, while the
map crosses 10,000 Heap Fetches in ~12-14 h and at times far faster.
=> DO NOT RE-TUNE autovacuum_vacuum_insert_threshold AGAIN ON A FITTED RATIO. That is the error
   this section exists to stop being repeated. Any number chosen that way is refuted by the next
   change in the update rate.

THE BURST CAVEAT, so nobody promotes the wrong number. The 15:00Z -> 15:08Z interval is ~5-9
minutes (bounded by two now() readings, not stamped inside the probe), so its implied rate of
9,000-16,700/h is a BURST MEASUREMENT and must not be quoted as a steady rate. The defensible
steady figure is the 11:12Z -> 15:00Z average, ~2,500/h. Both are far above what the insert
trigger can govern; that conclusion does not depend on which one you use.
=> If you re-measure, STAMP now() INSIDE THE SAME STATEMENT AS THE PROBE. This pass did not, and
   it cost the sharpest number in the table.

THE HEDGE STILL CANNOT RUN. pg_cron jobid 380 maint-vacuum-sales-hot-partition has never once
succeeded: it is owned by role postgres, which has NO statement_timeout in rolconfig and so
inherits the cluster's 120 s, and its first and only run (2026-08-29 10:20:00Z) was cancelled at
120.1 s "while scanning relation public.sales_2026". Repairing it needs BOTH a
GRANT MAINTAIN ON public.sales_2026 TO cron_heavy AND an unschedule+reschedule under
SET LOCAL ROLE cron_heavy (pg_cron keys on (jobname, username), so the jobid changes). Neither
half alone is safe: the re-own without the grant produces a job that SKIPS the VACUUM with a
WARNING and reports "succeeded". That is queued for Trevor, not self-approved.
=> The registered escalation "if Heap Fetches is back above ~10,000, escalate to
   DISABLE_PAGE_SKIPPING" IS INAPPLICABLE AS WRITTEN: it escalates the options on a job that
   cannot start. DISABLE_PAGE_SKIPPING makes the VACUUM strictly slower and would time out
   sooner. Fix the role and the grant first; only then reconsider the options.

THE CANDIDATE LEVER, MEASURED BUT DELIBERATELY NOT SHIPPED. autovacuum_vacuum_scale_factor is
keyed on dead tuples, which IS the measured driver here. Current trigger is
50 + 0.05 * n_live_tup(1,041,884) = 52,144 against n_dead_tup ~3,160, i.e. roughly one firing per
113 h at ~460 non-HOT dead tuples/h. Lowering it to ~0.001 (trigger ~1,092) would fire about
every ~2.4 h, which is the cadence the decay demands. NOT SHIPPED because the cost lands on this
instance's binding constraint and there is an OPEN, UNRESOLVED hypothesis in the ledger
(2026-08-18 / 2026-08-2x, wallet_moments_cache) that an aggressive 2% scale factor there is a
contributor to the IO spells -- and because sizing a second knob off a 4.57-minute window would
repeat the exact error this section documents. It needs a longer measurement and Trevor's call.

HOW TO RE-MEASURE (supersedes the recipe above only in that step 1 is unnecessary for THIS
number): Heap Fetches does not depend on ANALYZE. Run the probe, stamp now() in the same
statement, and read n_tup_upd / n_tup_ins alongside it.
$txt$;

  EXECUTE format('COMMENT ON TABLE public.sales_2026 IS %L', v_before || v_add);

  SELECT obj_description('public.sales_2026'::regclass, 'pg_class') INTO v_check;

  IF v_check IS NULL
     OR position('THE FALSIFIER IS MET' in v_check) = 0
     OR position('INSERTS ARE NOT THE DRIVER' in v_check) = 0
     OR left(v_check, 3891) <> v_before THEN
    RAISE EXCEPTION 'post-state readback failed: appended section missing or the pre-image was not preserved (length now %)', length(v_check);
  END IF;

  RAISE NOTICE 'sales_2026 comment: % -> % chars', length(v_before), length(v_check);
END
$mig$;
-- audit_20260829_leaderboard_sweep_fails_on_a_fresh_visibility_map
--
-- Metadata only. APPENDS a dated section to the comment on
-- public.analytics_sales_leaderboard(...) installed by 20260829090940.
-- No signature change, no grants, no behaviour, no data.
--
-- Guards: asserts the PRE-STATE md5 of the existing comment, so a concurrent edit
-- is never clobbered; post-state readback re-checks that the pre-image survives
-- intact at the head of the new comment.
--
-- REVERT (truncates back to exactly the 20260829090940 text):
--   DO $r$ DECLARE c text; BEGIN
--     SELECT obj_description(
--       'public.analytics_sales_leaderboard(text,timestamptz,timestamptz,text[],integer,numeric,boolean)'::regprocedure,
--       'pg_proc') INTO c;
--     EXECUTE format('COMMENT ON FUNCTION public.analytics_sales_leaderboard(text,timestamptz,timestamptz,text[],integer,numeric,boolean) IS %L', left(c, 3328));
--   END $r$;

DO $mig$
DECLARE
  v_sig  text := 'public.analytics_sales_leaderboard(text,timestamptz,timestamptz,text[],integer,numeric,boolean)';
  v_oid  oid;
  v_old  text;
  v_new  text;
  v_read text;
  c_md5  constant text := 'bffeccd78cef8703a661da2d281fd3cc';
  c_len  constant int  := 3328;
BEGIN
  SET LOCAL lock_timeout = '5s';

  v_oid := v_sig::regprocedure::oid;
  v_old := obj_description(v_oid, 'pg_proc');

  IF v_old IS NULL THEN
    RAISE EXCEPTION 'PRE-STATE FAILED: the function carries no comment; 20260829090940 is missing';
  END IF;
  IF length(v_old) <> c_len OR md5(v_old) <> c_md5 THEN
    RAISE EXCEPTION
      'PRE-STATE FAILED: comment is not the 20260829090940 text (len % md5 %, expected % / %) -- '
      'a concurrent session edited it; re-read before appending',
      length(v_old), md5(v_old), c_len, c_md5;
  END IF;

  v_new := v_old || '

=== 2026-08-29 17:0xZ (10:0x PT) -- A SECOND TEN-WIDE SWEEP FAILED 10 OF 10, ON THE FRESHEST
=== VISIBILITY MAP RECORDED ALL DAY. THE MAP IS NOT WHAT GOVERNS THIS.
(Cowork cloud pass. Nothing above is retracted. The 09:09Z section already said "the visibility map
 is NOT the cause this time"; that was an inference from serial timings. This is the CONTROL.)

THE SWEEP. Vercel production, read 17:06Z: 16:53:25Z -> 16:53:44Z, five collections x two roles,
all cache=MISS, ALL TEN returned 500 on "rpc_error canceling statement due to statement timeout".
Identical shape to the 07:22:14-07:22:38Z sweep. 24 h denominator at 17:05Z: 30 x 500 / 10 x 200
= 40 requests; last 3 h: 10 x 500 and ZERO 200s.
=> ON REAL SWEEPS THE FIX c26ae1981 IS NOW 1 OF 3, NOT 1 OF 2. Update that fraction, do not requote it.

*** THE CONTROL, AND IT IS THE POINT OF THIS SECTION. ***
The map was at its FRESHEST of the day when the sweep failed. Timeline, all read live:
  15:08:00Z  Heap Fetches 16,806 on the shape-matched sales_2026 probe (the falsifier, met)
  15:45:02Z  AUTOVACUUM fires on public.sales_2026 -- the FIRST firing of the 1500 insert
             threshold set by 20260829111140. pg_stat_all_tables.autovacuum_count 11 -> 12.
  16:53:25Z  the ten-wide sweep -- 10 of 10 fail
  17:01:50Z  Heap Fetches 2,248, Buffers 15,241 on the SAME probe
2,248 is LOWER than the 3,363 measured 6.7 h after the 00:22:38Z manual VACUUM, i.e. the map was in
better condition at 16:53Z than at any earlier reading on record for this table today. The sweep
still failed 10 of 10, 68 minutes after the vacuum and 8 minutes before the 2,248 reading.
=> VISIBILITY-MAP STALENESS DOES NOT GOVERN THE TEN-WIDE SWEEP FAILURE. Do not re-open it, and do
   not let a future green vacuum reading be read as "the leaderboard is fixed".

LOAD SHAPE, CORROBORATED BY AN INDEPENDENT INSTRUMENT THIS TIME. audit_20260828_underpriced_board_cost
(jobid 373, */10) samples a DIFFERENT public board and knows nothing about this route. Over the whole
14:00-17:00Z window its ms/call floor is 31-298 and its worst reading is the 16:50Z sample:
18,600 ms/call at 360 reads/call -- ORDINARY read volume, worst latency of the window.
  * ORDERING MATTERS AND IT RUNS THE RIGHT WAY: the 16:50Z sample differences 16:40Z->16:50Z, so it
    measures the ten minutes BEFORE the 16:53Z sweep. The contention PRECEDED the sweep; the sweep
    did not manufacture it. The 17:00Z sample, which does contain the sweep, reads 3,000 ms/call at
    298 reads -- still ~10-15x the quiet floor.
pg_cron convergence around it (cron.job_run_details, read 17:06Z):
  rpc-refresh-wmc-fmv-changed      16:47:00 -> 16:53:03Z   363.4 s
  rpc-refresh-wmc-fmv-changed      16:37:00 -> 16:43:22Z   382.0 s
  rpc-allday-nem-from-sales-backfill                       295.0 s
  rpc-refresh-pack-reality-dist                            174.8 s
  rpc-allday-cross-source-sales-dedup                      137.3 s
  rpc-refresh-special-serial-owners-mv                     132.5 s
  rpc-refresh-pack-realized-ev                             106.0 s
rpc-refresh-wmc-fmv-changed at ~363 s heads this list exactly as it headed the 07:22Z list.
*** BUT STATE THE DISANALOGY RATHER THAN BURYING IT: at 07:22Z that job OVERLAPPED the sweep; at
16:53Z it ENDED 22 SECONDS BEFORE IT. So what replicates across the two instances is the dense
convergence BAND, not literal concurrency with one named job.
=> Still a HYPOTHESIS. NO CONCURRENCY POSITIVE CONTROL HAS BEEN RUN, and running one would
   deliberately load prod. What is now established, and was not before, is that the sweep fails with
   the map fresh -- so whatever the residual cause is, vacuuming will not reach it.

WHAT THIS DOES TO THE QUEUED LEVER. The COLLECTION PUSH-DOWN (measured 28,928 -> 13,835 buffers) is
unchanged as the one lever with a number on it, and this section strengthens its case rather than
altering it: halving the buffers of each of ten concurrent copies is a contention remedy, which is
the family of cause that survives. Its blockers are unchanged and are NOT timidity -- it changes a
public analytics view WITH A DEPENDENT (analytics_sales_resolved) plus a SECURITY DEFINER function,
and a Cowork cloud session can neither push the paired migration file nor run the repo suite against
a changed view. It belongs to whoever holds git.

STILL CLOSED, do not revive on the strength of this section: materialising this leaderboard (Trevor,
explicit); the prior_addrs correlated-EXISTS rewrite (measured and refuted).';

  EXECUTE format('COMMENT ON FUNCTION %s IS %L', v_sig, v_new);

  v_read := obj_description(v_oid, 'pg_proc');
  IF v_read IS NULL OR v_read <> v_new THEN
    RAISE EXCEPTION 'POST-STATE FAILED: readback does not match what was written';
  END IF;
  IF left(v_read, c_len) <> v_old THEN
    RAISE EXCEPTION 'POST-STATE FAILED: the pre-image was damaged by the append';
  END IF;
END
$mig$;

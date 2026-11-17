DO $mig$
DECLARE
  v_existing text;
BEGIN
  SELECT obj_description('public.sales_2026'::regclass, 'pg_class') INTO v_existing;
  IF v_existing IS NOT NULL AND length(btrim(v_existing)) > 0 THEN
    RAISE EXCEPTION 'ABORT: public.sales_2026 already carries a comment (% chars). This migration assumes NONE and will not clobber it. Re-author as a guarded splice.', length(v_existing);
  END IF;

  COMMENT ON TABLE public.sales_2026 IS
$note$Hot sales partition. Read the note below BEFORE measuring this table's visibility map.

=== 2026-08-29 07:04Z (00:04 PT) — INSTRUMENT TRAP: pg_class.relallvisible is a FROZEN STATISTIC ===

pg_class.relallvisible is a PLANNER STATISTIC, written only by VACUUM and ANALYZE. It does NOT
track the visibility map between them. Reading it to measure VM decay returns the value frozen at
last_vacuum/last_analyze, no matter how much time has passed.

MEASURED, with a positive control:
  * 2026-08-29 05:09Z and again 06:59Z both read relallvisible 38,172 / relpages 38,341
    => 169 pages not-all-visible, 99.559%. IDENTICAL across 1.8 h of continuous inserts.
    Both were the value frozen by the 00:54Z ANALYZE.
  * A fresh ANALYZE at 07:04:43Z read 36,684 / 38,341 => 1,657 pages not-all-visible, 95.678%.
    9.8x the frozen figure. Only the ANALYZE changed between the two readings.
  * relpages is frozen the same way and is NOT a usable freshness check on the statistic:
    it read 38,341 while pg_relation_size/8192 also read 38,341, because VACUUM freed space that
    inserts then reused through the FSM. Equal page counts do not mean the stats are current.

CONSEQUENCE — one recorded projection is an artifact and is RETRACTED HERE. The 2026-08-29 05:09Z
"~37 pages/h, ~370 pages ~= ~9,600 rows just before the 10:20Z vacuum" was computed by dividing a
post-vacuum residual by elapsed time on this frozen statistic. The real two-point rate, both
endpoints ANALYZE-anchored (00:54Z -> 07:04Z, 6.17 h): 169 -> 1,657 pages = ~241 pages/h, ~6.5x the
projected rate. WARNING: two points only, and the first sits 32 min after the VACUUM, so early-phase
decay may not be linear. Do not promote ~241/h to a rate without more anchors.

=== THE FALSIFIER, MEASURED DIRECTLY RATHER THAN PROJECTED ===

Thread #9 / migration 20260829002812 (pg_cron jobid 380 maint-vacuum-sales-hot-partition,
"20 10 * * *", VACUUM (ANALYZE) public.sales_2026) registers: escalate to DISABLE_PAGE_SKIPPING if
Heap Fetches on that index-only scan is back above ~10,000.

Read 07:05Z, +6.7 h after the 00:22Z VACUUM, EXPLAIN (ANALYZE, BUFFERS):
  Index Only Scan using idx_sales_2026_pulse_window
  (collection = 'nba_top_shot' AND sold_at >= now() - '30 days')
  rows 117,343 | Heap Fetches 3,363 | Buffers hit 13,029 read 3,211 | 1,797 ms
=> FALSIFIER NOT MET at +6.7 h. Only 2.9% of scanned rows needed a heap fetch, so the
   not-all-visible pages are spread across the whole partition, not concentrated in the hot slice —
   which is why the page count grew 9.8x while heap fetches stayed low.

CAVEAT, stated so nobody compares the wrong numbers: this probe is a shape-matched PROXY, single
process with collection pinned as an Index Cond. The recorded before/after figures for the
2026-08-29 leaderboard fix (66,218 -> 0 Heap Fetches; 74,754 -> 28,928 buffers) came from the
leaderboard function's PARALLEL Index Only Scan over a wider predicate. Compare the Heap Fetches
TREND on this probe against those; do NOT compare its absolute buffer counts.

VERDICT ON THE HEDGE, on this evidence: the daily 10:20Z vacuum looks adequate WITH margin — the
opposite of the 05:09Z reading, which called it "just under the falsifier with almost no margin".
Both passes were wrong in the same direction for the same reason: they read a frozen statistic.
Do NOT unschedule jobid 380 on this note; one measurement is not a decay curve.

=== HOW TO RE-MEASURE ===
  1. Run ANALYZE public.sales_2026 FIRST (or state the last_analyze your reading is anchored to).
  2. Prefer the EXPLAIN probe above — Heap Fetches is what the falsifier is written in.
  3. pg_visibility is NOT installed on this project; do not assume pg_visibility_map_summary exists.

ⓘ This pass ran ANALYZE public.sales_2026 at 07:04:43Z solely to un-freeze the statistic. That is
the same operation jobid 380 performs daily; it writes no table data.$note$;
END
$mig$;
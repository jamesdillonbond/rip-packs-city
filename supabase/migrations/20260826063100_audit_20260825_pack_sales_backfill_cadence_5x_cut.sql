-- audit_20260825_pack_sales_backfill_cadence_5x_cut
--
-- RECORD-ONLY. The change was two `cron.alter_job` calls made through
-- `execute_sql`, which writes NO row to `supabase_migrations.schema_migrations`.
-- This file is the repo's copy of what happened and of how to undo it.
--
-- ── WHAT CHANGED (2026-08-25 PT / 2026-08-26 06:31Z) ───────────────────────────
--   jobid 25  rpc-allday-pack-sales-backfill   `*/3 * * * *`    -> `0,15,30,45 * * * *`
--   jobid 29  rpc-topshot-pack-sales-backfill  `1-58/3 * * * *` -> `1,16,31,46 * * * *`
-- 480 dispatches/day each -> 96/day each. Offset by one minute so the two do not
-- contend for a pg_cron worker slot in the same second (`max_worker_processes = 6`
-- against `cron.max_running_jobs = 32` is a live starvation source on this box).
--
-- ── WHY, MEASURED ──────────────────────────────────────────────────────────────
-- Both jobs call Supabase edge functions whose source is NOT in this repo, which
-- POST batches through PostgREST as
--   INSERT INTO <t> … ON CONFLICT (tx_hash, pack_nft_id) DO UPDATE SET <every column>
-- with NO change-detection predicate. So every re-walk of already-ingested history
-- rewrites every row identically: a new heap tuple, three index entries, and WAL,
-- for information that did not change.
--
-- From `pg_stat_statements` over its 14.2027-day window (reset 2026-08-12 01:34Z —
-- ⚠ a DATED SAMPLE; re-derive, do not quote):
--
--   statement                                    calls/d   disk GB/d  dirtied/d   WAL MB/d   s/d
--   INSERT … topshot_pack_sales_history           10,497      10.54     727,588     2,498    10,662
--   INSERT … allday_pack_sales_history             7,012       4.91     401,312     1,251     5,405
--   SELECT topshot_pack_sales_history LIMIT/OFFSET    196      28.67     229,460       399     1,649
--   SELECT allday_pack_sales_history  LIMIT/OFFSET    219      27.76     216,518       404     1,906
--   ------------------------------------------------------------------------------------------
--   TOTAL                                                      71.88   1,574,878     4,552    19,622
--
-- 71.9 GB/day of disk reads (~9% of the instance's measured ~780 GB/day), 1.57M
-- blocks dirtied/day and 4.55 GB/day of WAL — to add ~165 new rows/day
-- (topshot 1,122 rows in 7 d; allday 35 rows in 7 d).
--
-- ⚠ Hits and reads are reported separately on purpose. `shared_blks_hit` for these
-- four is far larger and is NOT disk IO; summing them and calling the total "reads"
-- is the mistake this box's whole IO story is vulnerable to.
--
-- ── WHY A CADENCE CUT AND NOT THE REAL FIX ─────────────────────────────────────
-- The real fix is change-detection at the writer, and it is NOT available here:
--   * the writers are edge functions with no committed source (deep-audit R21: 29
--     deployed functions have none), so the upsert cannot be edited from the repo;
--   * `suppress_redundant_updates_trigger()` — Postgres' built-in for exactly this
--     shape — WAS considered and deliberately NOT shipped. When it suppresses a
--     row the UPDATE is skipped, so that row produces NO `RETURNING` output and
--     PostgREST's `page_total` falls. An uncommitted caller that asserts on the
--     returned count would break SILENTLY, and at 5 new rows/day on allday the
--     breakage would not be observable for days. Filed, not shipped.
-- A schedule change alters no semantics, is one statement to undo, and takes ~80%
-- of the cost out immediately.
--
-- ── WHY 15 MINUTES IS NOT A FRESHNESS REGRESSION ───────────────────────────────
-- Measured at the time of the change, the newest row in each table was already
-- 3.4 h old (topshot) and 15.3 h old (allday). These feeds are not near-real-time
-- and nothing downstream treats them as such; the previous 3-minute cadence bought
-- no freshness it was not already failing to deliver.
--
-- ⚠ FALSIFIER, and it should be RUN rather than assumed: over the 24 h after this
-- change, `n_tup_ins` on both tables should track its prior daily rate (topshot
-- ~160/day, allday ~5/day) while `n_tup_upd` falls roughly 5x. If INSERTS fall too,
-- the walk was covering ground and this cut is wrong — revert it.
--
-- ── REVERT ─────────────────────────────────────────────────────────────────────
--   SELECT cron.alter_job(25, schedule := '*/3 * * * *');
--   SELECT cron.alter_job(29, schedule := '1-58/3 * * * *');

DO $$
DECLARE
  v25 text;
  v29 text;
BEGIN
  SELECT schedule INTO v25 FROM cron.job WHERE jobid = 25;
  SELECT schedule INTO v29 FROM cron.job WHERE jobid = 29;

  -- Assert the PROPERTY (dispatches per hour is bounded), not the exact string, so
  -- a later re-stagger does not red this for no reason.
  IF v25 IS NULL OR v29 IS NULL THEN
    RAISE WARNING 'jobid 25/29 not found — the pack-sales backfills were renamed or removed';
  ELSIF v25 LIKE '%/3 %' OR v29 LIKE '%/3 %' THEN
    RAISE EXCEPTION 'a pack-sales backfill is back on a 3-minute cadence (25=%, 29=%) — '
                    'see this migration for the 71.9 GB/day it costs', v25, v29;
  END IF;
END $$;

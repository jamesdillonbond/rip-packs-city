-- audit_20260830: cron jobid 215 `rpc-allday-nem-from-sales-backfill`,
-- `37 * * * *` -> `37 3,7,11,15,19,23 * * *` (hourly -> every 4 h).
-- Schedule only; the command is re-passed VERBATIM from the catalog (never
-- retyped): md5 c7ea2df3c66232e984f4ce5839649a2b, length 196, unchanged.
-- Permission recipe and guards copied from 20260817015354 (the halving): the
-- job is cron_heavy's, postgres cannot alter_job it, cron_heavy cannot execute
-- alter_job, so cron.schedule AS THE OWNER updates in place; RESET ROLE is
-- mandatory before apply_migration's own register insert.
--
-- WHY (measured 2026-08-30 14:31-15:1xZ, desktop pass; ledger "AllDay hygiene"):
-- * 24 runs / 24 h at 227 s mean = ~1.5 h/day of cron_heavy time; one call in
--   the 14:31->14:48Z pgss diff: 263 s, 1,784,409 buffer hits.
-- * Where the hits go: the `unmapped_nfts` CTE takes the 80,385 unresolved
--   AllDay nft_ids (104,841 rows) and, for EACH, probes the nft_id index of
--   EVERY sales partition -- sales_2020 .. sales_2026, ~240k buffers apiece --
--   because nft_id is not the partition key. EXPLAIN ANALYZE of that CTE alone:
--   1,776,537 hits + 33,367 reads, 56 s, and it returned ZERO rows.
-- * What the hour buys: nft_edition_map AllDay inserts per hour today were
--   2 / 13 / 3 / 2 / 8 / 11 / 14 / 25 / 30 / 1 / 2 / 3 -- and those mappings
--   serve HISTORICAL unmapped rows: 0 of the last 24 h's 343 AllDay sales
--   (by sold_at) carry source = promoted_from_unmapped. New unresolved
--   arrivals are 6 rows / 25 h (47 ingested, 41 already resolved).
-- So mapping latency is a backfill-freshness number, not a market-data one,
-- and <= 4 h instead of <= 1 h costs nothing a user can see, for -75 % of the
-- job's IO. The 08-17 note "HALVED, NOT LEAPT" is honoured in spirit: this is
-- one step (x4), with a re-measure before any further cut. The slots avoid the
-- 08-09Z storm band and the 12-13Z seed-wallet wave.
--
-- The job's second statement (promote_unmapped_sales for AllDay) is also
-- throttled since 20260830150207 and is called by the indexers regardless.
--
-- ⚠ A CADENCE CUT IS NOT A SPEED FIX: per-run duration is unchanged. The real
-- fix -- candidates from (new unmapped rows since last run) UNION (nfts with a
-- new priced sale since last run) -- needs an ingested_at index on the
-- partitioned sales table (a heavy build under saturation) and is filed, not
-- shipped.
--
-- Exit (48 h): jobid 215 runs 6/day at ~227 s, nft_edition_map AllDay inserts
-- per day unchanged (~150-250), `unmapped_resolution_backlog_max` in trust
-- health does not rise. Falsifier: inserts/day fall materially -> the hourly
-- runs were finding rows the 4-hourly ones miss (they should not: p_limit is
-- 5,000 against ~10/h of work); revert to hourly.
-- Revert: same block with '37 * * * *'.
-- anon-exec: none (no function created or replaced).

DO $guard$
DECLARE
  v_user text;
  v_md5  text;
  v_n    integer;
BEGIN
  SELECT username, md5(command) INTO v_user, v_md5 FROM cron.job WHERE jobid = 215;
  IF v_user IS DISTINCT FROM 'cron_heavy' THEN
    RAISE EXCEPTION 'jobid 215 owner is %, expected cron_heavy -- aborting', v_user;
  END IF;
  IF v_md5 IS DISTINCT FROM 'c7ea2df3c66232e984f4ce5839649a2b' THEN
    RAISE EXCEPTION 'jobid 215 command md5 is %, expected c7ea2df3c66232e984f4ce5839649a2b -- aborting', v_md5;
  END IF;
  SELECT count(*) INTO v_n FROM cron.job WHERE jobname = 'rpc-allday-nem-from-sales-backfill';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'expected exactly 1 job named rpc-allday-nem-from-sales-backfill, found % -- aborting', v_n;
  END IF;
END
$guard$;

SET LOCAL ROLE cron_heavy;

SELECT cron.schedule(
         'rpc-allday-nem-from-sales-backfill',
         '37 3,7,11,15,19,23 * * *',
         (SELECT command FROM cron.job WHERE jobid = 215)
       );

RESET ROLE;

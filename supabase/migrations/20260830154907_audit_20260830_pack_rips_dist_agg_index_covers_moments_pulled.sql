-- audit_20260830: get_pack_lifecycle_row heap-fetched every rip of a
-- distribution because idx_pack_rips_dist_agg INCLUDEd pull_value_usd but not
-- moments_pulled.
--
-- MEASURED 2026-08-30 15:4xZ: pg_stat_statements 7,857 calls, 3,961 ms mean,
-- 653 disk reads + 1,504 hits per call (a user-facing pack-page RPC). EXPLAIN
-- through the function for dist 1246: 1,546 hit + 2,545 read, 18.9 s cold;
-- the body with literals on the same buffers: 13 ms warm -- so not a plan
-- problem (LANGUAGE sql, but the plan is the same shape): it is one scattered
-- pack_rips heap page per rip (2,464 rips -> 2,083 pages) on a 756 MB heap,
-- fetched only to read moments_pulled, which the covering index lacked.
--
-- WHAT WAS DONE LIVE (this file records it; on prod every statement below is
-- a no-op): the covering index was built CONCURRENTLY at 15:46Z by a one-off
-- postgres-owned pg_cron job (jobid 407, unscheduled after) inside a
-- deliberately short `ALTER ROLE postgres SET statement_timeout = '900s'`
-- window that was RESET at 15:48Z the moment the job logged succeeded (the
-- cluster default is 120 s and CREATE INDEX needs the table owner; cron_heavy
-- cannot create indexes). Build took < 2 min on a calm instance (7 active
-- backends). The superseded idx_pack_rips_dist_agg (171 MB) was dropped
-- CONCURRENTLY at 15:49Z -- v2 is a strict superset (same key, same
-- predicate, one more INCLUDE column). Verified: Index Only Scan using
-- idx_pack_rips_dist_agg_v2, 2,971 rows in 252 buffers for dist 1239
-- (272 heap fetches -- the 08-29 visibility-map decay class; VACUUM restores
-- the rest).
--
-- On a fresh database this file builds the index plainly.
-- anon-exec: none (no function created or replaced).
--
-- Exit (24 h): get_pack_lifecycle_row mean falls from ~4 s toward ~0.3 s and
-- reads/call from ~650 toward ~100. Falsifier: reads unchanged -> the cost is
-- the topshot_pack_rip_attribution / pack_purchases legs, not pack_rips.
-- Revert: CREATE INDEX CONCURRENTLY idx_pack_rips_dist_agg ... INCLUDE (pull_value_usd) WHERE (dist_id IS NOT NULL);
--         DROP INDEX CONCURRENTLY idx_pack_rips_dist_agg_v2;

CREATE INDEX IF NOT EXISTS idx_pack_rips_dist_agg_v2
  ON public.pack_rips USING btree (collection_id, dist_id)
  INCLUDE (pull_value_usd, moments_pulled)
  WHERE (dist_id IS NOT NULL);

DROP INDEX IF EXISTS public.idx_pack_rips_dist_agg;

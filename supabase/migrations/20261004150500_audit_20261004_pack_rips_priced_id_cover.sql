-- audit_20261004_pack_rips_priced_id_cover
--
-- 2026-10-04 ~8:05 AM PT (Claude Code, Trevor's box). Second of two pack-page fixes (the first is
-- 20261004145000, the lifecycle leg). The `[pack-detail] pack_realized_ev … read exceeded 5000ms`
-- error fired 3 times in the 24 h to 7:27 AM PT 10-04, always on a cold dist page.
--
-- MEASURED (body of get_pack_realized_ev_row, dist 7160, cold-ish): 1,347 ms, of which 1,309 ms is
-- the `r` CTE. It probes pack_rips_pkey for the dist's 1,427 attributed rip ids, then visits the
-- heap for every one to test `pull_value_usd IS NOT NULL` and drops 1,425 of them. That cost 2,431
-- disk reads. pg_stat_statements recorded 12,647 blocks READ per cold EXPLAIN of the function.
-- 20260831163201 already made this one ordered scan; it could not avoid the heap visit, because
-- pack_rips_pkey does not carry pull_value_usd.
--
-- FIX. A partial index of priced rips only (370,596 of 3,712,230 rows), keyed on id and carrying
-- pull_value_usd. The `r` CTE already says `pr.pull_value_usd IS NOT NULL`, so the planner can use
-- it with no function change: an Index Only Scan where an unpriced rip is simply absent. The index
-- is small enough to stay resident, unlike the 109 MB pkey plus 765 MB heap. Built CONCURRENTLY via
-- execute_sql; IF NOT EXISTS makes this apply a no-op on production.
--
-- RESULT: see the ledger entry of 2026-10-04 (~8 AM PT).
--
-- REVERT: DROP INDEX CONCURRENTLY IF EXISTS public.idx_pack_rips_priced_id;

CREATE INDEX IF NOT EXISTS idx_pack_rips_priced_id
  ON public.pack_rips USING btree (id)
  INCLUDE (pull_value_usd)
  WHERE (pull_value_usd IS NOT NULL);

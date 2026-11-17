-- 2026-10-17 (Claude Code cloud). An index on the OPEN chain-arrival probes, so the five
-- every-minute chain-arrival lanes stop seq-scanning the whole probe table to find the few open ones.
--
-- WHY. run_chain_arrival_lane() finds pending probes with
--   `request_id IS NULL AND status IN ('floor', 'bisect', 'window', 'walk')`
-- but the only partial index (idx_chain_arrival_probes_pending) covers three of those four statuses
-- (no 'walk', added 09-30), so the planner cannot use it. Every call therefore seq-scanned all
-- 8,568 pages (161,569 probes, 160,979 of them 'done') to find 590 open rows. The four offset lanes'
-- gate `EXISTS (... status NOT IN ('done','failed'))` had no index either. The lanes run five
-- times a minute, and the 590 open probes are all `floor` probes parked on the dark mainnet24 node
-- (#181), so the lanes keep firing: pgss had them at ~7.8-10.1 k blocks per call, the largest
-- buffer user by call count (2,400 calls / 23.7 M blocks in the 10-16 06:05-16:05 UTC window).
--
-- HOW. A partial index on the open set, `status NOT IN ('done', 'failed')`, serves the pending
-- scan (the planner proves the IN-list implies it) and the gate. Measured after a CONCURRENT build:
-- pending scan 8,568 -> 214 buffers (53 ms -> 1 ms); gate EXISTS -> 3 buffers. 16 kB.
-- No behaviour change: same rows, same order of work. The #181 retire/keep decision (10-24) is
-- untouched.
--
-- Built first with CREATE INDEX CONCURRENTLY via execute_sql (10-17 ~9:19 AM PT, indisvalid);
-- this statement is a no-op there and builds it on a fresh database.
-- REVERT: DROP INDEX public.idx_chain_arrival_probes_open;
SET lock_timeout = '10s';
CREATE INDEX IF NOT EXISTS idx_chain_arrival_probes_open
  ON public.chain_arrival_probes (status, lo, hi)
  WHERE status NOT IN ('done', 'failed');

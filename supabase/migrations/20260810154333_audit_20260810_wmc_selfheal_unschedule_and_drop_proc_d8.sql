-- audit_20260810_wmc_selfheal_unschedule_and_drop_proc_d8
--
-- D8 correction: a SCAN-BASED scheduled self-heal is not viable on this instance
-- right now. Measured live 2026-08-10 (heavy mid-day disk-IO saturation):
--   * global single-statement sweep  -> failed at the 300s cap (all-or-nothing;
--     the outer timeout even aborted its own log write, leaving no pipeline_runs row)
--   * per-collection COMMIT procedure -> "invalid transaction termination" — pg_cron
--     wraps every job command in a transaction, so a procedure cannot COMMIT here
--   * AllDay-scoped single call        -> ALSO failed at 300s (324k-row scan too slow)
-- Root blocker: finding NULL-metadata rows requires a wmc scan (no NULL index by
-- design — the register vetoed a `player_name IS NULL` partial for HOT), and scans
-- time out under saturation.
--
-- So: unschedule the failing cron and drop the dead procedure. KEEP the function
-- public.rpc_wmc_metadata_selfheal(uuid) as a manual/ad-hoc scoped repair tool (it
-- healed UFC's 4,556-row backlog in 39s during a calmer moment). The automated
-- sweep is DEFERRED pending a HOT-safe `created_at` index (created_at is insert-only,
-- so no HOT concern — distinct from the vetoed NULL index) that lets the sweep scope
-- to recently-created rows cheaply, built via CREATE INDEX CONCURRENTLY in a quiet
-- window. See register D8.

SELECT cron.unschedule('rpc-wmc-metadata-selfheal');
DROP PROCEDURE IF EXISTS public.rpc_wmc_metadata_selfheal_all();

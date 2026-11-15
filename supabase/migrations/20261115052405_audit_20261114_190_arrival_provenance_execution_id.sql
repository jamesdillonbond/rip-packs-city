-- audit_20261114_190_arrival_provenance_execution_id
--
-- WHAT (#190 step 2): topshot_arrival_provenance gains a nullable dune_execution_id so
-- /api/cron/stage-topshot-acquisitions-dune?lane=provenance can tell whether the latest execution of
-- the wallet-scoped provenance query (9129489) is already loaded, the same way its purchases lane does.
-- Additive; the per-batch lane (topshot-arrival-provenance-dune) does not write it and is unaffected.
--
-- REVERT: DROP INDEX public.topshot_arrival_provenance_exec_idx;
--         ALTER TABLE public.topshot_arrival_provenance DROP COLUMN dune_execution_id;

ALTER TABLE public.topshot_arrival_provenance ADD COLUMN IF NOT EXISTS dune_execution_id text;
CREATE INDEX IF NOT EXISTS topshot_arrival_provenance_exec_idx
  ON public.topshot_arrival_provenance (dune_execution_id);

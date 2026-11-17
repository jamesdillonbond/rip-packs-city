-- audit_20261114_190_transfer_hop_stage
--
-- WHAT (#190 step 3; Trevor 2026-11-14 10:11 PM PT "Keep going"): review table for the transfer hop —
-- how the SENDER of each moment transferred into a saved wallet had acquired it (Dune query 9129613).
-- Service-role only. Nothing reads it; pricing transfers from it is Trevor's decision.
--
-- REVERT: DROP TABLE public.topshot_transfer_hop_stage;

CREATE TABLE IF NOT EXISTS public.topshot_transfer_hop_stage (
  wallet            text        NOT NULL,
  nft_id            text        NOT NULL,
  sender            text        NOT NULL,
  transfer_date     date,
  hop_tx            text        NOT NULL,
  hop_date          date,
  hop_kind          text        NOT NULL CHECK (hop_kind IN ('MP','LC','OC','P','N','S','T')),
  hop_price         numeric,
  hop_from          text,
  dune_query_id     text        NOT NULL,
  dune_execution_id text        NOT NULL,
  staged_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (wallet, nft_id)
);
COMMENT ON TABLE public.topshot_transfer_hop_stage IS
  'Known-issue #190 step 3 REVIEW table: for moments transferred into saved wallets, how the sender acquired each one (Dune private temp query 9129613). Written only by /api/cron/stage-topshot-acquisitions-dune?lane=hop. Not a cost-basis source.';
CREATE INDEX IF NOT EXISTS topshot_transfer_hop_stage_exec_idx ON public.topshot_transfer_hop_stage (dune_execution_id);
ALTER TABLE public.topshot_transfer_hop_stage ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.topshot_transfer_hop_stage FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.topshot_transfer_hop_stage TO service_role;

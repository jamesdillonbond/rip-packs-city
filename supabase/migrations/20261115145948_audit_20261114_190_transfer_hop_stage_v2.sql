-- audit_20261114_190_transfer_hop_stage_v2
--
-- Applied 2026-11-15 ~7:00 AM PT after Trevor approved the confirmation.
-- WHAT (#190 step 3): reshape the still-EMPTY topshot_transfer_hop_stage for query 9129613 v2, which
-- returns each sender's latest arrival keyed (sender, nft_id) instead of (recipient wallet, nft_id).
-- Refuses to run if the table holds any row.
--
-- REVERT: DROP TABLE public.topshot_transfer_hop_stage; (then re-apply 20261115061349 for the v1 shape)

DO $$ BEGIN
  IF (SELECT count(*) FROM public.topshot_transfer_hop_stage) <> 0 THEN
    RAISE EXCEPTION 'topshot_transfer_hop_stage is not empty; refusing to reshape it';
  END IF;
END $$;
DROP TABLE public.topshot_transfer_hop_stage;
CREATE TABLE public.topshot_transfer_hop_stage (
  sender            text        NOT NULL,
  nft_id            text        NOT NULL,
  hop_height        bigint,
  hop_date          date,
  hop_tx            text        NOT NULL,
  hop_kind          text        NOT NULL CHECK (hop_kind IN ('MP','LC','OC','P','N','S','T')),
  hop_price         numeric,
  hop_from          text,
  dune_query_id     text        NOT NULL,
  dune_execution_id text        NOT NULL,
  staged_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (sender, nft_id)
);
CREATE INDEX topshot_transfer_hop_stage_exec_idx ON public.topshot_transfer_hop_stage (dune_execution_id);
ALTER TABLE public.topshot_transfer_hop_stage ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.topshot_transfer_hop_stage FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.topshot_transfer_hop_stage TO service_role;

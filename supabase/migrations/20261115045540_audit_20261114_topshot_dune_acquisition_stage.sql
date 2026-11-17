-- audit_20261114_topshot_dune_acquisition_stage
--
-- WHAT (known-issue #190, Trevor 2026-11-14 ~8:50 PM PT: "I have the analyst plan ... do #1"):
--   1. public.topshot_dune_acquisition_stage — a REVIEW table for pre-2023-11-08 marketplace buys of
--      Top Shot moments that saved wallets still hold, read from Dune flow.cadence_events by the
--      private temp query 9129456 and paged in by /api/cron/stage-topshot-acquisitions-dune.
--      NOTHING reads it and nothing copies it into moment_acquisitions: Trevor reviews it first
--      (standing rule — no estate-wide cost-basis write without his review).
--   2. dune_budget_state re-pointed at the Analyst plan Trevor confirmed: 4,000 credits per cycle,
--      cycle resets on the 14th (Dune getUsage: billing period 2026-11-14 -> 2026-12-14), paused=false.
--      No Dune lane has a caller (vercel.json, .github, cron.job all empty of Dune), so unpausing
--      starts nothing; the new stage route honours `paused` as its kill switch.
--
-- Row rule (from the #190 probe): a buy counts only when the purchase event sits in the SAME tx as the
-- TopShot.Deposit that brought the still-held copy TO this wallet, and the purchase names the same id.
-- Service-role only: RLS on, no policies, no grants to anon/authenticated (the table names user wallets).
--
-- REVERT:
--   DROP TABLE public.topshot_dune_acquisition_stage;
--   UPDATE public.dune_budget_state SET paused = true, cycle_credit_cap = 2500, cycle_anchor_day = 24 WHERE id = 1;

CREATE TABLE IF NOT EXISTS public.topshot_dune_acquisition_stage (
  wallet            text        NOT NULL,
  nft_id            text        NOT NULL,
  acquired_at       timestamptz NOT NULL,
  tx_hash           text        NOT NULL,
  price_usd         numeric     NOT NULL,
  market            text        NOT NULL,
  seller            text,
  dune_query_id     text        NOT NULL,
  dune_execution_id text        NOT NULL,
  staged_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (wallet, nft_id),
  CONSTRAINT topshot_dune_acquisition_stage_wallet_shape CHECK (wallet ~ '^0x[0-9a-f]{16}$'),
  CONSTRAINT topshot_dune_acquisition_stage_price_nonneg CHECK (price_usd >= 0)
);

COMMENT ON TABLE public.topshot_dune_acquisition_stage IS
  'Known-issue #190 REVIEW table: pre-2023-11-08 marketplace buys of still-held Top Shot moments in saved wallets, from Dune (private temp query 9129456). Written only by /api/cron/stage-topshot-acquisitions-dune. NOT a cost-basis source until Trevor reviews it.';

CREATE INDEX IF NOT EXISTS topshot_dune_acquisition_stage_exec_idx
  ON public.topshot_dune_acquisition_stage (dune_execution_id);

ALTER TABLE public.topshot_dune_acquisition_stage ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.topshot_dune_acquisition_stage FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.topshot_dune_acquisition_stage TO service_role;

UPDATE public.dune_budget_state
   SET paused = false,
       cycle_credit_cap = 4000,
       cycle_anchor_day = 14,
       note = note || ' | 2026-11-14 ~8:55 PM PT: Trevor confirmed the ANALYST plan (4,000 credits/cycle; Dune getUsage billing period 11-14 -> 12-14). paused true -> false, cycle_credit_cap 2500 -> 4000, cycle_anchor_day 24 -> 14. The datapoint caps above are the retired FREE-plan meter; Analyst meters credits, so a lane must not size itself on them. No Dune lane is scheduled; the #190 stage route honours paused. REVERT: paused=true, cycle_credit_cap=2500, cycle_anchor_day=24.',
       updated_at = now()
 WHERE id = 1;

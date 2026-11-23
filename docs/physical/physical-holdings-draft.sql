-- DRAFT — physical cards data model (2026-11-22). NOT a migration: kept out of
-- supabase/migrations/ on purpose (migration-parity CI expects every committed
-- file there to be applied). Move it there only when Trevor approves Lane B.
--
-- Scoping: "Physical Cards on RPC — Scoping" (claude.ai artifact) + the
-- prototype in lib/physical/. Rules baked in:
--   * Physical values NEVER enter fmv_snapshots, sales or any RPC FMV view.
--     They live in physical_value_cache, credited to their source.
--   * Input is an identifier (grader + cert, or a catalogue pick) — no wallet,
--     no sign-in beyond the RPC account (rpc-no-wallet-signin).
--   * internal_confidence is never selected by a public route
--     (rpc-fmv-confidence-is-internal-only).
--   * Licensed rows must be deletable in one statement: the HobbyCardIndex
--     terms require deleting stored data within 30 days of a plan ending.
--
-- Revert: DROP TABLE public.physical_value_cache, public.physical_holdings, public.physical_cards;

-- 1. Catalogue: one row per card as the price source identifies it.
CREATE TABLE IF NOT EXISTS public.physical_cards (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source          text NOT NULL CHECK (source IN ('hci', 'gemrate', 'manual')),
  source_card_id  text NOT NULL,
  category        text NOT NULL CHECK (category IN ('basketball','football','baseball','hockey','soccer','pokemon','magic','marvel','other')),
  name            text NOT NULL,
  player_name     text,                 -- for joining to /players/<slug> hubs by name → person (a-name-is-not-a-person)
  year            int,
  set_name        text,
  card_number     text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source, source_card_id)
);

-- 2. What a user says they own. One row per slab (cert) or per raw lot.
CREATE TABLE IF NOT EXISTS public.physical_holdings (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  card_id         uuid NOT NULL REFERENCES public.physical_cards(id),
  grader          text NOT NULL CHECK (grader IN ('psa','bgs','cgc','sgc','raw')),
  grade           text NOT NULL,       -- '10', '9.5' … or 'raw'
  cert_number     text,                -- graded only
  raw_condition   text CHECK (raw_condition IN ('mint','near_mint','excellent','very_good','poor')),
  quantity        int  NOT NULL DEFAULT 1 CHECK (quantity BETWEEN 1 AND 999),
  cost_basis_usd  numeric(12,2),
  acquired_on     date,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK ((grader = 'raw') = (cert_number IS NULL)),
  CHECK (grader <> 'raw' OR raw_condition IS NOT NULL),
  CHECK (grader = 'raw' OR quantity = 1)  -- a cert is one card
);
CREATE UNIQUE INDEX IF NOT EXISTS physical_holdings_one_cert_per_user
  ON public.physical_holdings (user_id, grader, cert_number) WHERE cert_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS physical_holdings_user ON public.physical_holdings (user_id);

-- 3. Licensed value ranges (output of lib/physical/valuation-range.ts).
CREATE TABLE IF NOT EXISTS public.physical_value_cache (
  card_id             uuid NOT NULL REFERENCES public.physical_cards(id) ON DELETE CASCADE,
  grader              text NOT NULL,
  grade               text NOT NULL,
  low_usd             numeric(12,2),
  point_usd           numeric(12,2),
  high_usd            numeric(12,2),
  sales_used          int NOT NULL,
  newest_sale_at      timestamptz,
  stale               boolean NOT NULL,
  internal_confidence text,            -- INTERNAL ONLY
  source              text NOT NULL,   -- shown as the credit line
  computed_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (card_id, grader, grade)
);

ALTER TABLE public.physical_cards       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.physical_holdings    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.physical_value_cache ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.physical_cards, public.physical_holdings, public.physical_value_cache FROM PUBLIC, anon;
GRANT SELECT ON TABLE public.physical_cards TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.physical_holdings TO authenticated;
-- physical_value_cache: service_role only; routes select the public columns.
GRANT ALL ON TABLE public.physical_cards, public.physical_holdings, public.physical_value_cache TO service_role;

CREATE POLICY physical_cards_read ON public.physical_cards
  FOR SELECT TO authenticated USING (true);
-- (select auth.uid()) form per the 11-16 rls_initplan fix.
CREATE POLICY physical_holdings_select_own ON public.physical_holdings
  FOR SELECT TO authenticated USING (user_id = (select auth.uid()));
CREATE POLICY physical_holdings_insert_own ON public.physical_holdings
  FOR INSERT TO authenticated WITH CHECK (user_id = (select auth.uid()));
CREATE POLICY physical_holdings_update_own ON public.physical_holdings
  FOR UPDATE TO authenticated USING (user_id = (select auth.uid())) WITH CHECK (user_id = (select auth.uid()));
CREATE POLICY physical_holdings_delete_own ON public.physical_holdings
  FOR DELETE TO authenticated USING (user_id = (select auth.uid()));

COMMENT ON TABLE public.physical_value_cache IS
  'Licensed physical-card value ranges. Never joined into RPC FMV. Delete all rows for a source within 30 days of its plan ending (HCI terms). DRAFT 2026-11-22.';

-- Applied to prod via Supabase MCP on 2026-07-26 as
-- audit_20260726_candy_sales_unresolved_deadletter. Committed here for parity.
--
-- Candy (Solana/Magic Eden) secondary-sales DEAD LETTER.
--
-- WHY: candy-sales-indexer walks ME activities newest-first and stops at the
-- first activity <= max(sold_at) already in `sales`. A sale it SEES but cannot
-- write (DAS getAsset throw, unresolvable serial, edition not yet ingested,
-- missing SOL rate, per-tick asset-fetch budget) is only retried while it is
-- still the newest thing: the moment a NEWER sale lands, the cursor moves past
-- it and it is never fetched again. Measured 2026-07-26 over 25 logged runs:
-- 359 found vs 322 written = 37 skipped, with the loss invisible (ok=true).
--
-- PK is (signature, token_mint) because one ME signature can carry several
-- items; note `sales` itself still dedups on transaction_hash alone, so a
-- second item under the same signature resolves to a 23505 and is closed out
-- as `duplicate_tx_hash` rather than retried forever.
--
-- REVERT: DROP TABLE IF EXISTS public.candy_sales_unresolved;

CREATE TABLE IF NOT EXISTS public.candy_sales_unresolved (
  signature       text        NOT NULL,
  token_mint      text        NOT NULL,
  collection_id   uuid        NOT NULL,
  block_time      timestamptz,
  price_sol       numeric,
  buyer           text,
  seller          text,
  skip_reason     text        NOT NULL,
  attempts        integer     NOT NULL DEFAULT 1,
  first_seen_at   timestamptz NOT NULL DEFAULT now(),
  last_attempt_at timestamptz NOT NULL DEFAULT now(),
  resolved_at     timestamptz,
  resolution      text,
  CONSTRAINT candy_sales_unresolved_pkey PRIMARY KEY (signature, token_mint)
);

ALTER TABLE public.candy_sales_unresolved ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.candy_sales_unresolved FROM anon, authenticated;

CREATE INDEX IF NOT EXISTS idx_candy_sales_unresolved_open
  ON public.candy_sales_unresolved (block_time)
  WHERE resolved_at IS NULL;

COMMENT ON TABLE public.candy_sales_unresolved IS
  'Dead letter for Magic Eden Candy sales the indexer saw but could not write. Drained by /api/candy-sales-indexer each tick. resolved_at IS NULL = still owed. Added 2026-07-26.';

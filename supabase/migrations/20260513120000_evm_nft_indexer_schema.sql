-- 20260513120000_evm_nft_indexer_schema.sql
--
-- Generic ERC-721 transfer event indexer. Beezie Collectibles on Base is the
-- first registered contract; adding more is a single INSERT into
-- evm_nft_contracts.
--
-- Tables:
--   evm_nft_contracts     — registry of (chain_id, contract_address) targets
--   evm_indexer_cursors   — per-contract walk-forward block cursor
--   evm_nft_transfers     — Transfer event log, RANGE-partitioned on block_timestamp
--
-- Cron writes block_timestamp = NULL on first ingest (rows land in the
-- DEFAULT partition); a future timestamp-resolution cron promotes them into
-- the monthly partitions.

-- Registry of ERC-721 contracts to index
CREATE TABLE IF NOT EXISTS public.evm_nft_contracts (
  id BIGSERIAL PRIMARY KEY,
  chain_id INTEGER NOT NULL REFERENCES public.evm_chains(chain_id),
  contract_address TEXT NOT NULL,
  label TEXT NOT NULL,
  start_block BIGINT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (chain_id, contract_address)
);

COMMENT ON TABLE public.evm_nft_contracts IS 'ERC-721 contracts to index for Transfer events. start_block = block to begin scanning from on first run.';

-- Per-contract cursor tracking
CREATE TABLE IF NOT EXISTS public.evm_indexer_cursors (
  id BIGSERIAL PRIMARY KEY,
  chain_id INTEGER NOT NULL,
  contract_address TEXT NOT NULL,
  last_processed_block BIGINT NOT NULL,
  last_advanced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  total_transfers_indexed BIGINT NOT NULL DEFAULT 0,
  UNIQUE (chain_id, contract_address)
);

-- Transfer event log, partitioned by month on block_timestamp
CREATE TABLE IF NOT EXISTS public.evm_nft_transfers (
  id BIGSERIAL,
  chain_id INTEGER NOT NULL,
  contract_address TEXT NOT NULL,
  token_id NUMERIC(78) NOT NULL,
  from_address TEXT NOT NULL,
  to_address TEXT NOT NULL,
  block_number BIGINT NOT NULL,
  log_index INTEGER NOT NULL,
  transaction_hash TEXT NOT NULL,
  block_timestamp TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id, block_timestamp)
) PARTITION BY RANGE (block_timestamp);

-- Initial monthly partitions: current + next
CREATE TABLE IF NOT EXISTS public.evm_nft_transfers_2026_05
  PARTITION OF public.evm_nft_transfers
  FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');

CREATE TABLE IF NOT EXISTS public.evm_nft_transfers_2026_06
  PARTITION OF public.evm_nft_transfers
  FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');

-- DEFAULT partition catches NULL block_timestamp + any unbucketed rows.
-- The ingest cron writes block_timestamp = NULL on first pass; a later
-- resolution job moves rows into the monthly partitions.
CREATE TABLE IF NOT EXISTS public.evm_nft_transfers_unresolved
  PARTITION OF public.evm_nft_transfers
  DEFAULT;

-- Dedup key. NULLS NOT DISTINCT so NULL block_timestamp rows still dedup
-- on re-ingest (PG15+; this project is PG17).
CREATE UNIQUE INDEX IF NOT EXISTS uq_evm_nft_transfers_event
  ON public.evm_nft_transfers (chain_id, contract_address, token_id, block_number, log_index, block_timestamp)
  NULLS NOT DISTINCT;

CREATE INDEX IF NOT EXISTS idx_evm_nft_transfers_token
  ON public.evm_nft_transfers (chain_id, contract_address, token_id);

CREATE INDEX IF NOT EXISTS idx_evm_nft_transfers_to
  ON public.evm_nft_transfers (chain_id, LOWER(to_address));

CREATE INDEX IF NOT EXISTS idx_evm_nft_transfers_from
  ON public.evm_nft_transfers (chain_id, LOWER(from_address));

-- Seed Beezie Collectibles on Base.
-- Contract total supply at write time: ~16,520. start_block 22000000 is the
-- ~Dec 2025 launch window on Base — gives the cron a finite forward walk.
INSERT INTO public.evm_nft_contracts (chain_id, contract_address, label, start_block, is_active)
VALUES (8453, '0xbb5ec6fd4b61723bd45c399840f1d868840ca16f', 'beezie_collectibles', 22000000, TRUE)
ON CONFLICT (chain_id, contract_address) DO NOTHING;

-- RLS
ALTER TABLE public.evm_nft_contracts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.evm_indexer_cursors ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.evm_nft_transfers ENABLE ROW LEVEL SECURITY;

-- Read-only authenticated access on the catalog + log tables.
-- evm_indexer_cursors intentionally has no read policy: service_role only.
DROP POLICY IF EXISTS "evm_nft_contracts_read_authenticated" ON public.evm_nft_contracts;
CREATE POLICY "evm_nft_contracts_read_authenticated" ON public.evm_nft_contracts
  FOR SELECT TO authenticated USING (TRUE);

DROP POLICY IF EXISTS "evm_nft_transfers_read_authenticated" ON public.evm_nft_transfers;
CREATE POLICY "evm_nft_transfers_read_authenticated" ON public.evm_nft_transfers
  FOR SELECT TO authenticated USING (TRUE);

-- service_role bypasses RLS but grant explicitly for clarity.
GRANT ALL ON public.evm_nft_contracts TO service_role;
GRANT ALL ON public.evm_indexer_cursors TO service_role;
GRANT ALL ON public.evm_nft_transfers TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.evm_nft_contracts_id_seq TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.evm_indexer_cursors_id_seq TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.evm_nft_transfers_id_seq TO service_role;

-- Anon: no access.
REVOKE ALL ON public.evm_nft_contracts FROM anon;
REVOKE ALL ON public.evm_indexer_cursors FROM anon;
REVOKE ALL ON public.evm_nft_transfers FROM anon;

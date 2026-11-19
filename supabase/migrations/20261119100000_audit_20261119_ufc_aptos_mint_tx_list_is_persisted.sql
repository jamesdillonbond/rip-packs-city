-- audit_20261119_ufc_aptos_mint_tx_list_is_persisted
--
-- 2026-11-19 (PT, ~7:25 AM by DB clock; Claude Code cloud; Trevor: "Keep going").
-- scripts/ufc-aptos-wallet-link.mjs (GHA ufc-aptos-sales-ingest.yml, 4x a day) re-listed EVERY Aptos
-- issuer::mint_for tx from version 3,180,000,000 on every run: 580-720 s against a 720 s listing cap,
-- so half the runs died mid-list ("mint listing exceeded 720s after 6200 mints"; 11-18 5:45 AM, 10:03 PM,
-- 11-19 5:59 AM PT) and the rest found nothing to do -- all 5,077 unmatched mints belong to the mainnet26
-- spork, whose access node no longer resolves (ENOTFOUND). The list itself never changes except at its end.
--
-- WHAT. Persist it: ufc_aptos_mint_txs, one row per mint tx. The script lists only versions above the
-- stored maximum (ascending, so the stored set is always a complete PREFIX of the chain's list) and reads
-- its work from the table. A run that hits the listing cap keeps what it listed and carries on.
-- Service-role only, like ufc_aptos_migration_matches.
--
-- REVERT: DROP TABLE public.ufc_aptos_mint_txs; and revert scripts/ufc-aptos-wallet-link.mjs.

CREATE TABLE IF NOT EXISTS public.ufc_aptos_mint_txs (
  aptos_version bigint PRIMARY KEY,
  minted_at timestamptz NOT NULL,
  aptos_address text NOT NULL,
  listed_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.ufc_aptos_mint_txs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ufc_aptos_mint_txs FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.ufc_aptos_mint_txs TO service_role;

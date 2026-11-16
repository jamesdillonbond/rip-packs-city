-- UFC Strike Aptos holdings for wallets RPC can tie to a user (Trevor 2026-11-15: reopen UFC on Aptos only after
-- binders show Aptos UFC moments). One row per Aptos UFC token currently owned by an address in
-- ufc_aptos_wallet_links, written by scripts/ufc-aptos-holdings.mjs from the Aptos indexer
-- (current_token_ownerships_v2). get_ufc_aptos_holdings_for_flow() resolves a user's Dapper (Flow) address
-- to those holdings. Plan: claude/ufc-reopen-on-aptos-plan-2026-11-16.md.
-- Revert: DROP FUNCTION public.get_ufc_aptos_holdings_for_flow(text); DROP TABLE public.ufc_aptos_holdings;
CREATE TABLE public.ufc_aptos_holdings (
  token_data_id        text PRIMARY KEY CHECK (token_data_id ~ '^0x[0-9a-f]{1,64}$'),
  aptos_address        text NOT NULL,
  aptos_collection_id  text NOT NULL,
  edition_id           uuid REFERENCES public.editions(id),
  serial_number        integer,
  last_tx_version      bigint,
  last_tx_at           timestamptz,
  refreshed_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ufc_aptos_holdings_owner_idx ON public.ufc_aptos_holdings (aptos_address);
CREATE INDEX ufc_aptos_holdings_edition_idx ON public.ufc_aptos_holdings (edition_id);
COMMENT ON TABLE public.ufc_aptos_holdings IS
  'UFC Strike tokens currently owned on Aptos by addresses in ufc_aptos_wallet_links. token_data_id = Aptos token object address; edition_id via ufc_aptos_collections. Refreshed per owner by scripts/ufc-aptos-holdings.mjs (rows for tokens an owner no longer holds are removed).';
ALTER TABLE public.ufc_aptos_holdings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ufc_aptos_holdings FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.get_ufc_aptos_holdings_for_flow(p_flow_address text)
RETURNS TABLE (aptos_address text, link_confidence text, token_data_id text, edition_id uuid,
               serial_number integer, last_tx_at timestamptz, refreshed_at timestamptz)
LANGUAGE sql STABLE SET search_path = public AS $fn$
  SELECT h.aptos_address, l.confidence, h.token_data_id, h.edition_id, h.serial_number, h.last_tx_at, h.refreshed_at
    FROM ufc_aptos_wallet_links l
    JOIN ufc_aptos_holdings h ON h.aptos_address = l.aptos_address
   WHERE l.flow_address = lower(p_flow_address)
   ORDER BY h.edition_id, h.serial_number
$fn$;
REVOKE EXECUTE ON FUNCTION public.get_ufc_aptos_holdings_for_flow(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_ufc_aptos_holdings_for_flow(text) TO service_role;
-- anon-exec: revoked (get_ufc_aptos_holdings_for_flow) — new function; PUBLIC, anon, authenticated revoked above, service_role only.
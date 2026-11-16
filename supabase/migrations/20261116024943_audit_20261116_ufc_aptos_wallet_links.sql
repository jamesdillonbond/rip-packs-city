-- UFC Strike Flow -> Aptos wallet links, recovered by matching each Flow UFC_NFT burn to the Aptos
-- issuer::mint_for batch that follows it (same moments, ~1 min later). No chain stores the link itself.
-- Finding: claude/ufc-aptos-wallet-link-finding-2026-11-15.md. Lets RPC resolve a user's UFC Aptos wallet
-- from the Dapper (Flow) address they already give us, instead of asking for an Aptos address.
-- Revert: DROP TABLE public.ufc_aptos_wallet_links; ALTER TABLE public.ufc_aptos_ingest_state DROP COLUMN link_scanned_through_version;
CREATE TABLE public.ufc_aptos_wallet_links (
  flow_address       text NOT NULL CHECK (flow_address ~ '^0x[0-9a-f]{16}$'),
  aptos_address      text NOT NULL CHECK (aptos_address ~ '^0x[0-9a-f]{64}$'),
  method             text NOT NULL CHECK (method IN ('burn_mint_match','user_stated')),
  confidence         text NOT NULL CHECK (confidence IN ('high','medium')),
  burns              integer NOT NULL DEFAULT 0,
  exact_burns        integer NOT NULL DEFAULT 0,
  moments            integer NOT NULL DEFAULT 0,
  first_migrated_at  timestamptz,
  last_migrated_at   timestamptz,
  source_window      text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (flow_address, aptos_address)
);
CREATE INDEX ufc_aptos_wallet_links_aptos_idx ON public.ufc_aptos_wallet_links (aptos_address);
COMMENT ON TABLE public.ufc_aptos_wallet_links IS
  'UFC Strike Flow(Dapper)->Aptos wallet pairs. burn_mint_match: a Flow UFC_NFT burn tx matched to the Aptos issuer::mint_for batch(es) that followed it. high = at least one burn whose Aptos mint total equals the burn size and the Flow address maps to one Aptos wallet; medium = otherwise. burns/moments count matched burns and Aptos moments minted.';
ALTER TABLE public.ufc_aptos_wallet_links ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ufc_aptos_wallet_links FROM anon, authenticated;
ALTER TABLE public.ufc_aptos_ingest_state ADD COLUMN IF NOT EXISTS link_scanned_through_version bigint;
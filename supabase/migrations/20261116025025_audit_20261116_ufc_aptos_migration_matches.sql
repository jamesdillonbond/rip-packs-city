-- Batch-level evidence behind ufc_aptos_wallet_links: one row per Aptos issuer::mint_for tx, with the
-- Flow UFC_NFT burn tx it was matched to (or match='none' — e.g. the 20-moment Aptos pack-mint batches,
-- which have no Flow burn). Written by scripts/ufc-aptos-wallet-link.mjs; links are rebuilt from it.
-- Revert: DROP FUNCTION public.refresh_ufc_aptos_wallet_links(); DROP TABLE public.ufc_aptos_migration_matches;
CREATE TABLE public.ufc_aptos_migration_matches (
  aptos_version   bigint PRIMARY KEY,
  minted_at       timestamptz NOT NULL,
  aptos_address   text NOT NULL,
  n_minted        integer NOT NULL,
  flow_tx         text,
  flow_address    text,
  flow_burned_at  timestamptz,
  burn_size       integer,
  match           text NOT NULL CHECK (match IN ('count_exact','count_superset','none')),
  flow_spork      text,
  matched_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ufc_aptos_migration_matches_flow_tx_idx ON public.ufc_aptos_migration_matches (flow_tx) WHERE flow_tx IS NOT NULL;
ALTER TABLE public.ufc_aptos_migration_matches ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ufc_aptos_migration_matches FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.refresh_ufc_aptos_wallet_links()
RETURNS integer LANGUAGE sql SET search_path = public AS $fn$
  WITH burns AS (
    SELECT flow_tx, min(flow_address) flow_address, count(DISTINCT aptos_address) n_to,
           sum(n_minted) minted, max(burn_size) burn_size
      FROM ufc_aptos_migration_matches WHERE flow_tx IS NOT NULL AND flow_address IS NOT NULL GROUP BY flow_tx),
  pairs AS (
    SELECT m.flow_address, m.aptos_address, count(DISTINCT m.flow_tx) burns,
           count(DISTINCT m.flow_tx) FILTER (WHERE b.n_to = 1 AND b.minted = b.burn_size) exact_burns,
           sum(m.n_minted) moments, min(m.minted_at) first_at, max(m.minted_at) last_at,
           string_agg(DISTINCT m.flow_spork, ',') spork
      FROM ufc_aptos_migration_matches m JOIN burns b USING (flow_tx)
     GROUP BY m.flow_address, m.aptos_address),
  graded AS (
    SELECT p.*, CASE WHEN p.exact_burns > 0 AND count(*) OVER (PARTITION BY p.flow_address) = 1 THEN 'high' ELSE 'medium' END conf FROM pairs p),
  up AS (
    INSERT INTO ufc_aptos_wallet_links AS l (flow_address, aptos_address, method, confidence, burns, exact_burns, moments,
                                             first_migrated_at, last_migrated_at, source_window, updated_at)
    SELECT flow_address, aptos_address, 'burn_mint_match', conf, burns, exact_burns, moments, first_at, last_at, spork, now() FROM graded
    ON CONFLICT (flow_address, aptos_address) DO UPDATE SET
      confidence = EXCLUDED.confidence, burns = EXCLUDED.burns, exact_burns = EXCLUDED.exact_burns, moments = EXCLUDED.moments,
      first_migrated_at = EXCLUDED.first_migrated_at, last_migrated_at = EXCLUDED.last_migrated_at,
      source_window = EXCLUDED.source_window, updated_at = now()
    WHERE l.method = 'burn_mint_match'
    RETURNING 1)
  SELECT count(*)::int FROM up
$fn$;
REVOKE EXECUTE ON FUNCTION public.refresh_ufc_aptos_wallet_links() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_ufc_aptos_wallet_links() TO service_role;
-- anon-exec: revoked (refresh_ufc_aptos_wallet_links) — new function; PUBLIC, anon, authenticated revoked above, service_role only.
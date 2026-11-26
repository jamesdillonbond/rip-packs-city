-- audit_20261126_ufc_aptos_identity_link
--
-- 2026-11-26 ~8:40 AM PT (Claude Code cloud; Trevor: "Keep going").
--
-- WHY: ~73 % of UFC Aptos holdings belong to wallets that migrated Aug–Oct 2025 (Flow spork mainnet26).
-- The burn->mint matcher cannot link them: the mainnet26 nodes are gone (NXDOMAIN), and the Dune path waits
-- for the 2026-12-14 credit reset. But UFC's Aptos mint (issuer::mint_for) carries each Moment's SERIAL and
-- EDITION NAME, and serials survived the burn-and-mint. So for an RPC user whose Flow UFC Moments RPC already
-- knows, the Aptos wallet UFC minted THOSE SAME Moments to is that user's migration wallet — no Flow history
-- needed. Measured 2026-11-26: saved user 0xaf78…fe85 → 11 of 11 Moments found on Aptos were minted to one
-- wallet (0x740b…, one Aug 2025 burst); 0xbd94…50ac → 3 of 3 to one wallet.
--
-- A purchase alone is NOT evidence of holding at migration: 0x525b…943e's bought Moments went to 6 different
-- wallets (resold on Flow first). So candidates are Moments the user still held as far as RPC's records go:
--   * the user is the LAST recorded Flow buyer of that (edition, serial), or
--   * the user acquired it (moment_acquisitions) and no Flow sale to anyone else came after that acquisition.
--
-- 1. ufc_aptos_wallet_links.method gains 'moment_identity_match'. refresh_ufc_aptos_wallet_links() only
--    rewrites rows WHERE method = 'burn_mint_match', so these rows are never overwritten by it.
-- 2. get_ufc_identity_link_candidates(p_per_wallet): candidate Moments for saved Flow wallets with NO link of
--    any method yet, at most p_per_wallet per wallet (deterministic sample). Measured 2.4 s, 56k buffers,
--    9 wallets / 262 Moments. Called by scripts/ufc-aptos-identity-link.mjs (service role).
--
-- anon-exec: revoked (get_ufc_identity_link_candidates) — new SECURITY DEFINER reader over saved_wallets; REVOKE FROM PUBLIC, anon, authenticated below, service_role only.
--
-- Revert:
--   DROP FUNCTION public.get_ufc_identity_link_candidates(integer);
--   DELETE FROM public.ufc_aptos_wallet_links WHERE method = 'moment_identity_match';
--   ALTER TABLE public.ufc_aptos_wallet_links DROP CONSTRAINT ufc_aptos_wallet_links_method_check,
--     ADD CONSTRAINT ufc_aptos_wallet_links_method_check CHECK (method = ANY (ARRAY['burn_mint_match','user_stated']));

ALTER TABLE public.ufc_aptos_wallet_links DROP CONSTRAINT ufc_aptos_wallet_links_method_check;
ALTER TABLE public.ufc_aptos_wallet_links ADD CONSTRAINT ufc_aptos_wallet_links_method_check
  CHECK (method = ANY (ARRAY['burn_mint_match'::text, 'user_stated'::text, 'moment_identity_match'::text]));

CREATE FUNCTION public.get_ufc_identity_link_candidates(p_per_wallet integer DEFAULT 15)
RETURNS TABLE (flow_address text, aptos_collection_id text, serial_number integer, why text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  WITH sw AS (
    SELECT DISTINCT lower(wallet_addr) a FROM saved_wallets WHERE lower(wallet_addr) ~ '^0x[0-9a-f]{16}$'),
  unl AS (
    SELECT a FROM sw WHERE a NOT IN (SELECT l.flow_address FROM ufc_aptos_wallet_links l)),
  ls AS MATERIALIZED (
    SELECT DISTINCT ON (s.edition_id, s.serial_number) s.edition_id, s.serial_number, s.nft_id,
           lower(s.buyer_address) buyer, s.sold_at
      FROM sales s
     WHERE s.collection_id = '9b4824a8-736d-4a96-b450-8dcc0c46b023' AND s.source <> 'aptos_indexer_v1' AND s.serial_number > 0
     ORDER BY s.edition_id, s.serial_number, s.sold_at DESC),
  held AS (
    SELECT ls.buyer w, ls.edition_id, ls.serial_number, 'last_buyer' why FROM ls WHERE ls.buyer IN (SELECT a FROM unl)
    UNION
    SELECT lower(ma.wallet), ls.edition_id, ls.serial_number, 'acquisition'
      FROM moment_acquisitions ma JOIN ls ON ls.nft_id = ma.nft_id
     WHERE ma.collection_id = '9b4824a8-736d-4a96-b450-8dcc0c46b023' AND lower(ma.wallet) IN (SELECT a FROM unl)
       AND (ls.buyer = lower(ma.wallet) OR ls.sold_at <= ma.acquired_date)),
  ranked AS (
    SELECT h.w, c.aptos_collection_id, h.serial_number, h.why,
           row_number() OVER (PARTITION BY h.w ORDER BY md5(c.aptos_collection_id || ':' || h.serial_number)) rn
      FROM (SELECT DISTINCT ON (w, edition_id, serial_number) * FROM held ORDER BY w, edition_id, serial_number, why DESC) h
      JOIN ufc_aptos_collections c ON c.edition_id = h.edition_id)
  SELECT w, aptos_collection_id, serial_number, why FROM ranked WHERE rn <= greatest(1, least(p_per_wallet, 50))
$$;

REVOKE EXECUTE ON FUNCTION public.get_ufc_identity_link_candidates(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_ufc_identity_link_candidates(integer) TO service_role;

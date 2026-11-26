-- audit_20261126_ufc_identity_candidates_skip_still_on_flow
--
-- 2026-11-26 ~9:10 AM PT (Claude Code cloud; Trevor: "Keep going"). Follow-up to 20261126162202.
--
-- A local dry run of scripts/ufc-aptos-identity-link.mjs on 3 wallets found 0 of 17 candidates on Aptos, and the
-- reason was not the matcher: every one of those Moments is STILL HELD ON FLOW (wallet_moments_cache), i.e. never
-- migrated. Measured per wallet (candidates still on Flow / all candidates, p_per_wallet 50): 0x28ed… 5/5,
-- 0x4b82… 26/26, 0xa550… 10/10, 0x577d… 1/1, 0xb7a9… 2/2, 0xbd94… 39/50; 0xaf78… 0/50.
-- A Moment still on Flow cannot be on Aptos, so it only burns indexer calls and, worse, crowds the per-wallet
-- sample — a partly migrated wallet (0xbd94…: 39 of 50 unmigrated) could sample none of its migrated Moments.
-- Candidates now exclude any (edition, serial) the wallet still holds on Flow per wallet_moments_cache.
--
-- anon-exec: unchanged (get_ufc_identity_link_candidates) — CREATE OR REPLACE of the function created in 20261126162202; ACL preserved (has_function_privilege anon = false, authenticated = false, service_role = true, read 2026-11-26).
--
-- Revert: re-apply the function body from 20261126162202_audit_20261126_ufc_aptos_identity_link.sql.

CREATE OR REPLACE FUNCTION public.get_ufc_identity_link_candidates(p_per_wallet integer DEFAULT 15)
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
  on_flow AS (
    SELECT lower(w.wallet_address) w, ed.id edition_id, w.serial_number
      FROM wallet_moments_cache w
      JOIN editions ed ON ed.external_id = w.edition_key AND ed.collection_id = w.collection_id
     WHERE w.collection_id = '9b4824a8-736d-4a96-b450-8dcc0c46b023' AND lower(w.wallet_address) IN (SELECT a FROM unl)),
  held AS (
    SELECT ls.buyer w, ls.edition_id, ls.serial_number, 'last_buyer' why FROM ls WHERE ls.buyer IN (SELECT a FROM unl)
    UNION
    SELECT lower(ma.wallet), ls.edition_id, ls.serial_number, 'acquisition'
      FROM moment_acquisitions ma JOIN ls ON ls.nft_id = ma.nft_id
     WHERE ma.collection_id = '9b4824a8-736d-4a96-b450-8dcc0c46b023' AND lower(ma.wallet) IN (SELECT a FROM unl)
       AND (ls.buyer = lower(ma.wallet) OR ls.sold_at <= ma.acquired_date)),
  migratable AS (
    SELECT h.* FROM held h
     WHERE NOT EXISTS (SELECT 1 FROM on_flow f WHERE f.w = h.w AND f.edition_id = h.edition_id AND f.serial_number = h.serial_number)),
  ranked AS (
    SELECT h.w, c.aptos_collection_id, h.serial_number, h.why,
           row_number() OVER (PARTITION BY h.w ORDER BY md5(c.aptos_collection_id || ':' || h.serial_number)) rn
      FROM (SELECT DISTINCT ON (w, edition_id, serial_number) * FROM migratable ORDER BY w, edition_id, serial_number, why DESC) h
      JOIN ufc_aptos_collections c ON c.edition_id = h.edition_id)
  SELECT w, aptos_collection_id, serial_number, why FROM ranked WHERE rn <= greatest(1, least(p_per_wallet, 50))
$$;

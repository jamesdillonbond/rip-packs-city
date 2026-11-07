-- audit_20261106_pack_history_index_naming_the_distributor_is_not_a_transfer
--
-- A pack Dapper DELIVERED to this wallet, that Dapper's own index then names as
-- held by the DISTRIBUTOR it came from, has not left — the index is stale.
--
-- THE CASE (2026-11-06, Cowork, Trevor's /dashboard/packs read in his Chrome):
-- 13 reward packs on 0xbd94…50ac read "TRANSFERRED · Left this wallet without a
-- recorded sale · now held by 0x0b2a…7e29" — 0x0b2a3299cc857e29 is Top Shot's own
-- PackNFT / distribution account, the very address every one of them was
-- delivered FROM (pack_purchases.event_kind = primary_withdraw, is_primary_drop).
-- The chain (PackNFT.CollectionPublicPath getIDs() on the account, read via
-- rest-mainnet 2026-11-07 ~01:30Z) holds ALL 13, including two delivered 10-31.
-- Estate-wide the same shape covers 194 packs on 12 saved wallets, every one
-- delivered since 10-30 — #218's frozen sealed-pack index (~10-29) returns the
-- distributor as owner_address for packs it has not re-indexed, and the wallet
-- walk (the same index) does not list them either, so the 09-20 clean-walk floor
-- cannot rescue them. The reader then published a false account-level claim —
-- a collector's own unopened packs shown as gone, and left out of "Sealed packs
-- held" — the worst sub-class of the honesty rule.
--
-- FIX (read side, one expression): the index naming the pack's own primary
-- distributor after that distributor delivered it is NO evidence of a holder.
-- current_owner reads NULL for that case, so the 'transferred' arm cannot fire
-- on it and the pack falls through to 'held' on its delivery row — the same
-- "unknown decides nothing" posture the 09-20 change gave the departed case. A
-- pack genuinely sold on to ANOTHER collector still reads transferred (its index
-- owner is that collector, not the distributor); a pack that left to the
-- distributor is not a transaction Top Shot offers, so nothing real is masked.
--
-- Spliced into the LIVE prosrc (one anchor, asserted exactly once), header kept
-- verbatim from pg_get_functiondef; before/after on Trevor's wallet asserted in
-- the same transaction: 'transferred' 13 → 0, total packs unchanged.
--
-- anon-exec: unchanged (get_wallet_pack_history) — CREATE OR REPLACE of an existing fn; ACL preserved (anon=false, authenticated=false, read 2026-11-06).
--
-- Revert: re-run this file with v_old / v_new swapped (the anchor below is the
-- replacement text), or restore the body from
-- 20261020030627_audit_20261019_a_top_shot_pack_dapper_left_revealed_was_opened.sql.

DO $do$
DECLARE
  v_src text;
  v_new text;
  v_n   int;
  v_old text := E'      CASE WHEN v_sync_floor IS NOT NULL AND pi.owner_address = v_wallet\n'
             || E'                AND pi.checked_at < v_sync_floor THEN NULL\n'
             || E'           ELSE pi.owner_address\n'
             || E'      END AS current_owner,\n';
  v_rep text := E'      CASE WHEN v_sync_floor IS NOT NULL AND pi.owner_address = v_wallet\n'
             || E'                AND pi.checked_at < v_sync_floor THEN NULL\n'
             || E'           -- 2026-11-06: the index naming the pack''s OWN primary distributor\n'
             || E'           -- after that distributor delivered it here is a stale read (#218,\n'
             || E'           -- frozen sealed-pack index), not a holder: 13 of 13 such packs on\n'
             || E'           -- one wallet were on chain in the wallet. Unknown, never "left".\n'
             || E'           WHEN lb.bought_primary IS TRUE AND lb.bought_from IS NOT NULL\n'
             || E'                AND pi.owner_address = lb.bought_from THEN NULL\n'
             || E'           ELSE pi.owner_address\n'
             || E'      END AS current_owner,\n';
  v_t_before int; v_t_after int; v_all_before int; v_all_after int; v_h_before int; v_h_after int;
BEGIN
  SELECT p.prosrc INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'get_wallet_pack_history'
     AND pg_get_function_identity_arguments(p.oid) = 'p_wallet text, p_collection_slug text, p_status text, p_limit integer, p_offset integer';
  IF v_src IS NULL THEN RAISE EXCEPTION 'get_wallet_pack_history not found'; END IF;
  v_n := (length(v_src) - length(replace(v_src, v_old, ''))) / length(v_old);
  IF v_n <> 1 THEN RAISE EXCEPTION 'anchor expected once, found %', v_n; END IF;
  IF position('LEFT JOIN latest_buys  lb ON' IN v_src) = 0 THEN RAISE EXCEPTION 'lb alias not found'; END IF;
  v_new := replace(v_src, v_old, v_rep);

  v_t_before   := (public.get_wallet_pack_history('0xbd94cade097e50ac', 'nba_top_shot', 'transferred', 1, 0)->>'total_count')::int;
  v_h_before   := (public.get_wallet_pack_history('0xbd94cade097e50ac', 'nba_top_shot', 'held', 1, 0)->>'total_count')::int;
  v_all_before := (public.get_wallet_pack_history('0xbd94cade097e50ac', NULL, NULL, 1, 0)->>'total_count')::int;

  EXECUTE format(
    'CREATE OR REPLACE FUNCTION public.get_wallet_pack_history(p_wallet text, p_collection_slug text DEFAULT NULL::text, p_status text DEFAULT NULL::text, p_limit integer DEFAULT 50, p_offset integer DEFAULT 0) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO ''public'' SET statement_timeout TO ''20s'' AS %L',
    v_new);

  v_t_after   := (public.get_wallet_pack_history('0xbd94cade097e50ac', 'nba_top_shot', 'transferred', 1, 0)->>'total_count')::int;
  v_h_after   := (public.get_wallet_pack_history('0xbd94cade097e50ac', 'nba_top_shot', 'held', 1, 0)->>'total_count')::int;
  v_all_after := (public.get_wallet_pack_history('0xbd94cade097e50ac', NULL, NULL, 1, 0)->>'total_count')::int;

  IF v_all_after <> v_all_before THEN RAISE EXCEPTION 'total moved: % -> %', v_all_before, v_all_after; END IF;
  IF v_t_after >= v_t_before THEN RAISE EXCEPTION 'transferred did not fall: % -> %', v_t_before, v_t_after; END IF;
  IF v_h_after - v_h_before <> v_t_before - v_t_after THEN
    RAISE EXCEPTION 'held did not gain what transferred lost: held % -> %, transferred % -> %', v_h_before, v_h_after, v_t_before, v_t_after;
  END IF;
  RAISE NOTICE 'get_wallet_pack_history: transferred % -> %, held % -> %, total %', v_t_before, v_t_after, v_h_before, v_h_after, v_all_after;
END
$do$;

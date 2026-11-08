-- audit_20261108_candy_retire_wallet_unseen
--
-- The live Candy wallet read behind a pasted address (lib/candy/refresh-wallet.ts,
-- POST /api/candy/wallet-refresh, 2026-11-08) rewrites a wallet's Candy rows with
-- last_seen_at = now. A row of that wallet it did NOT touch is a card the wallet no
-- longer holds (sold, moved, sold back) — until now such rows lived until the next
-- daily census wrote the new owner, so a collector who sold today still saw the card.
--
-- candy_retire_wallet_unseen(wallet, walk_started_at) deletes exactly those rows:
-- this wallet, the Candy collection, last_seen_at before the walk began. The caller
-- invokes it ONLY after a complete walk (every page, every escrow-listed card, every
-- write) — an incomplete walk retires nothing. A concurrent census write for this
-- wallet carries a newer last_seen_at and is kept.
--
-- anon-exec: intentional — new function, REVOKEd from PUBLIC/anon/authenticated below; service_role only (candy_retire_wallet_unseen)
--
-- Rollback: DROP FUNCTION public.candy_retire_wallet_unseen(text, timestamptz);

CREATE OR REPLACE FUNCTION public.candy_retire_wallet_unseen(p_wallet text, p_walk_started_at timestamptz)
RETURNS integer
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_deleted integer := 0;
BEGIN
  IF p_wallet IS NULL OR length(p_wallet) < 32 OR p_walk_started_at IS NULL THEN
    RETURN 0;
  END IF;
  -- Scoped opt-in past rpc_guard_block_destructive: one wallet, one collection, rows
  -- a complete on-chain walk just proved the wallet no longer holds.
  PERFORM set_config('rpc.allow_bulk_delete', 'on', true);
  WITH del AS (
    DELETE FROM public.wallet_moments_cache w
     WHERE w.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid
       AND w.wallet_address = p_wallet
       AND w.last_seen_at < p_walk_started_at
    RETURNING 1
  )
  SELECT count(*) INTO v_deleted FROM del;
  RETURN v_deleted;
END;
$$;

REVOKE ALL ON FUNCTION public.candy_retire_wallet_unseen(text, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.candy_retire_wallet_unseen(text, timestamptz) TO service_role;

-- Snapshot migration: public.admin_verify_wallet(uuid, text, text).
--
-- MCP-applied to prod with no committed migration → UNPINNABLE. This commits the
-- CURRENT LIVE body verbatim (pg_get_functiondef 2026-08-02) so it can carry a
-- drift-guarded pinned test. Applying it is a no-op vs prod (byte-identical).
--
-- The owner-attested interim wallet-verification fallback (the working self-serve
-- path is the listing challenge; this is the manual override). It marks a
-- saved_wallets row verified (owner_attested) — upserting the row if the user
-- hasn't saved it yet — and grants the user the link_wallet earn exactly as a
-- real verification would (award_points per_user_limit=1 makes repeats no-ops).
-- Invariants worth pinning: strict arg validation (bad user/wallet → bad_args, no
-- write), case-insensitive wallet match so it never mints a duplicate row, and the
-- pre_existing_row honesty flag.
--
-- Pinned by supabase/tests/admin_verify_wallet.sql (which stubs award_points —
-- itself pinned separately — to isolate this function's own logic).

CREATE OR REPLACE FUNCTION public.admin_verify_wallet(p_user_id uuid, p_wallet_addr text, p_admin text DEFAULT 'owner'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_wallet text := lower(trim(p_wallet_addr)); v_updated int := 0; v_award jsonb;
BEGIN
  IF p_user_id IS NULL OR v_wallet !~ '^0x[0-9a-f]{16}$' THEN
    RETURN jsonb_build_object('ok',false,'error','bad_args'); END IF;

  UPDATE saved_wallets
     SET verified_at = now(), verification_method = 'owner_attested'
   WHERE user_id = p_user_id AND lower(wallet_addr) = v_wallet;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated = 0 THEN
    INSERT INTO saved_wallets(wallet_addr, user_id, verified_at, verification_method)
    VALUES (v_wallet, p_user_id, now(), 'owner_attested');
  END IF;

  -- The attested user gets the link_wallet earn exactly as if they verified
  -- (per_user_limit=1 makes repeats no-ops).
  v_award := award_points(p_user_id, 'link_wallet', v_wallet);

  RETURN jsonb_build_object('ok',true,'wallet',v_wallet,'pre_existing_row',v_updated>0,
                            'attested_by',p_admin,'link_wallet_award',v_award);
END $function$;

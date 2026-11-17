-- Snapshot migration: commit the VERBATIM live body of public.fulfill_redemption
-- so the DB-invariant test (supabase/tests/fulfill_redemption.sql) has a committed
-- source the drift guard can compare against. MCP-applied, no prior committed
-- migration → previously UNPINNABLE; byte-identical snapshot per the documented
-- remedy (CLAUDE.md "Testing & CI coverage"). Verified against live prosrc; the
-- pro-days regex uses a single-backslash `\d` (confirmed with position('\d')).
--
-- fulfill_redemption is the entitlement-GRANT side of the rewards trilogy
-- (award_points mints, redeem_shop_item spends, this delivers): it grants/extends
-- Pro (pro_users) or a cosmetic (user_cosmetics / profile_bio) for a redemption and
-- flips it to 'fulfilled'. Its most important property is IDEMPOTENCY — an
-- already-fulfilled redemption short-circuits so a re-run cannot double-grant Pro.
-- Re-applying this is a no-op (CREATE OR REPLACE with the live source).

CREATE OR REPLACE FUNCTION public.fulfill_redemption(p_redemption_id bigint, p_tx text DEFAULT NULL::text, p_note text DEFAULT NULL::text, p_admin text DEFAULT 'system'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  red record; it record; v_user uuid; v_wallet text; v_days int;
  v_slot text; v_value text; v_delivered text := 'manual';
BEGIN
  SELECT * INTO red FROM redemptions WHERE id = p_redemption_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'error','redemption_not_found'); END IF;
  IF red.status = 'fulfilled' THEN RETURN jsonb_build_object('ok',true,'already',true); END IF;
  IF red.status IN ('cancelled','refunded') THEN RETURN jsonb_build_object('ok',false,'error','redemption_'||red.status); END IF;
  SELECT * INTO it FROM shop_items WHERE id = red.shop_item_id;
  v_user := red.user_id;

  IF it.type = 'pro' THEN
    SELECT lower(wallet_addr) INTO v_wallet FROM saved_wallets
      WHERE user_id = v_user AND verified_at IS NOT NULL AND wallet_addr IS NOT NULL
      ORDER BY verified_at DESC LIMIT 1;
    IF v_wallet IS NULL THEN RETURN jsonb_build_object('ok',false,'error','no_verified_wallet'); END IF;
    v_days := coalesce((regexp_match(coalesce(it.metadata->>'grant',''), 'pro_(\d+)d'))[1]::int, 30);
    IF EXISTS (SELECT 1 FROM pro_users WHERE wallet_address = v_wallet) THEN
      UPDATE pro_users
         SET expires_at  = greatest(coalesce(expires_at, now()), now()) + make_interval(days => v_days),
             plan = 'admin', granted_by = 'rewards',
             grant_reason = 'redeem:'||coalesce(it.sku, it.id::text),
             subscribed_at = coalesce(subscribed_at, now())
       WHERE wallet_address = v_wallet;
    ELSE
      INSERT INTO pro_users(wallet_address, subscribed_at, expires_at, plan, granted_by, grant_reason, auto_renew)
      VALUES (v_wallet, now(), now() + make_interval(days => v_days), 'admin', 'rewards',
              'redeem:'||coalesce(it.sku, it.id::text), false);
    END IF;
    v_delivered := 'pro_'||v_days||'d';

  ELSIF it.type = 'cosmetic' THEN
    v_slot := it.metadata->>'slot'; v_value := it.metadata->>'value';
    INSERT INTO user_cosmetics(user_id, sku, slot, value)
      VALUES (v_user, it.sku, coalesce(v_slot,'cosmetic'), coalesce(v_value, it.sku))
      ON CONFLICT (user_id, sku) DO NOTHING;
    IF v_slot = 'border' THEN
      UPDATE profile_bio SET equipped_border = v_value, updated_at = now() WHERE user_id = v_user;
    ELSIF v_slot = 'banner' THEN
      UPDATE profile_bio SET equipped_banner = v_value, updated_at = now() WHERE user_id = v_user;
    END IF;
    v_delivered := 'cosmetic:'||coalesce(v_slot,'?')||':'||coalesce(v_value,'?');
  END IF;

  UPDATE redemptions
     SET status = 'fulfilled', fulfilled_at = now(), fulfilled_by = p_admin,
         fulfillment = coalesce(fulfillment,'{}'::jsonb) || jsonb_build_object('tx',p_tx,'note',p_note,'delivered',v_delivered)
   WHERE id = p_redemption_id;
  RETURN jsonb_build_object('ok',true,'type',it.type,'delivered',v_delivered);
END $function$;

-- Snapshot migration: commit the VERBATIM live body of public.redeem_shop_item
-- so the DB-invariant test (supabase/tests/redeem_shop_item.sql) has a committed
-- source the drift guard can compare against. This function was applied via the
-- Supabase MCP with no prior committed migration, so it was UNPINNABLE — the
-- documented remedy (see CLAUDE.md "Testing & CI coverage") is to author this
-- byte-identical snapshot first, then pin.
--
-- redeem_shop_item is the rewards-currency SPEND path (the mint side, award_points,
-- is already pinned): a user exchanges points_ledger credits for a shop item. A
-- regression here spends credits a user does not have, hands out free/out-of-stock
-- items, or double-books a per-user-limited redemption — so every guard is
-- load-bearing. This body is IDENTICAL to what is already live; re-applying it is
-- a no-op (CREATE OR REPLACE with the same source).

CREATE OR REPLACE FUNCTION public.redeem_shop_item(p_user_id uuid, p_item_id bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  it record; v_spendable bigint; v_status bigint; v_user_redeems int;
  v_verified boolean; v_ledger_id bigint; v_redemption_id bigint; v_deliver jsonb; v_status_out text;
BEGIN
  IF p_user_id IS NULL THEN RETURN jsonb_build_object('redeemed',false,'error','null_user'); END IF;
  -- Serialize this user's spend path (prevents concurrent over-spend).
  PERFORM pg_advisory_xact_lock(hashtext('rpc_rewards'), hashtext(p_user_id::text));

  SELECT * INTO it FROM shop_items WHERE id=p_item_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('redeemed',false,'error','item_not_found'); END IF;
  IF NOT it.active THEN RETURN jsonb_build_object('redeemed',false,'error','item_inactive'); END IF;
  IF it.stock IS NOT NULL AND it.stock <= 0 THEN RETURN jsonb_build_object('redeemed',false,'error','out_of_stock'); END IF;

  SELECT coalesce(sum(delta),0), coalesce(sum(status_delta),0) INTO v_spendable, v_status
    FROM points_ledger WHERE user_id=p_user_id;
  IF v_spendable < it.cost_credits THEN
    RETURN jsonb_build_object('redeemed',false,'error','insufficient_credits','spendable',v_spendable,'cost',it.cost_credits); END IF;

  IF it.min_status > 0 AND v_status < it.min_status THEN
    RETURN jsonb_build_object('redeemed',false,'error','status_too_low','required',it.min_status,'have',v_status); END IF;

  IF it.per_user_limit IS NOT NULL THEN
    SELECT count(*) INTO v_user_redeems FROM redemptions
     WHERE user_id=p_user_id AND shop_item_id=p_item_id AND status NOT IN ('cancelled','refunded');
    IF v_user_redeems >= it.per_user_limit THEN RETURN jsonb_build_object('redeemed',false,'error','per_user_limit_reached'); END IF;
  END IF;

  IF it.requires_verified_wallet THEN
    SELECT exists(SELECT 1 FROM saved_wallets WHERE user_id=p_user_id AND verified_at IS NOT NULL) INTO v_verified;
    IF NOT v_verified THEN RETURN jsonb_build_object('redeemed',false,'error','verified_wallet_required'); END IF;
  END IF;

  IF it.stock IS NOT NULL THEN
    UPDATE shop_items SET stock = stock - 1, updated_at = now() WHERE id=p_item_id;
  END IF;

  INSERT INTO points_ledger(user_id, delta, status_delta, kind, reason, ref, created_by)
  VALUES (p_user_id, -it.cost_credits, 0, 'spend', 'redeem:item:'||p_item_id, it.sku, 'system')
  RETURNING id INTO v_ledger_id;

  INSERT INTO redemptions(user_id, shop_item_id, cost_credits, status, ledger_id)
  VALUES (p_user_id, p_item_id, it.cost_credits, 'pending', v_ledger_id)
  RETURNING id INTO v_redemption_id;

  IF it.type = 'raffle' THEN
    INSERT INTO raffle_entries(shop_item_id, user_id, credits, ledger_id)
    VALUES (p_item_id, p_user_id, it.cost_credits, v_ledger_id);
  END IF;

  -- Instantly deliver digital goods; physical/Moment stay pending for manual fulfillment.
  v_status_out := 'pending';
  IF it.type IN ('pro','cosmetic') THEN
    v_deliver := fulfill_redemption(v_redemption_id, NULL, 'auto-on-redeem', 'system');
    IF (v_deliver->>'ok')::boolean THEN v_status_out := 'fulfilled'; END IF;
  END IF;

  SELECT coalesce(sum(delta),0) INTO v_spendable FROM points_ledger WHERE user_id=p_user_id;
  RETURN jsonb_build_object('redeemed',true,'redemption_id',v_redemption_id,'item',it.name,
                            'cost',it.cost_credits,'spendable',v_spendable,'status',v_status_out,
                            'delivered', coalesce(v_deliver->>'delivered', null));
END $function$;

-- DB invariant: public.redeem_shop_item(uuid,bigint) — the reward-currency SPEND
-- path (award_points is the mint side, already pinned). A user exchanges
-- points_ledger credits for a shop_items row. Every guard is load-bearing: a
-- regression spends credits a user does not have, hands out inactive/out-of-stock
-- items, ignores a per-user limit, or skips the verified-wallet gate. The pinned
-- properties: each guard returns the right error AND performs NO mutation (no
-- spend row, no redemption, stock unchanged) — and the happy path writes exactly
-- one -cost spend row (currency conservation), decrements stock by one, and
-- opens one pending redemption.
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20260802000100_audit_20260802_snapshot_redeem_shop_item.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts from it.
--
-- fulfill_redemption is an external dependency reached ONLY on type
-- IN ('pro','cosmetic'); every fixture item here is 'physical'/'raffle', so that
-- branch never executes and the function needs no stub (plpgsql binds the call
-- lazily, only when its statement first runs).
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE shop_items (
  id                        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sku                       text,
  name                      text,
  type                      text,
  cost_credits              int,
  stock                     int,
  per_user_limit            int,
  min_status                int DEFAULT 0,
  requires_verified_wallet  boolean DEFAULT false,
  active                    boolean DEFAULT true,
  updated_at                timestamptz DEFAULT now()
);
CREATE TABLE points_ledger (
  id           bigint GENERATED ALWAYS AS IDENTITY,
  user_id      uuid,
  delta        bigint,
  status_delta bigint,
  kind         text,
  reason       text,
  ref          text,
  created_by   text,
  created_at   timestamptz DEFAULT now()
);
CREATE TABLE redemptions (
  id           bigint GENERATED ALWAYS AS IDENTITY,
  user_id      uuid,
  shop_item_id bigint,
  cost_credits int,
  status       text,
  ledger_id    bigint
);
CREATE TABLE raffle_entries (
  id           bigint GENERATED ALWAYS AS IDENTITY,
  shop_item_id bigint,
  user_id      uuid,
  credits      int,
  ledger_id    bigint
);
CREATE TABLE saved_wallets (
  id          bigint GENERATED ALWAYS AS IDENTITY,
  user_id     uuid,
  verified_at timestamptz
);

-- >>> BEGIN verbatim redeem_shop_item (keep byte-identical to the migration) >>>
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
-- <<< END verbatim redeem_shop_item <<<

-- ── Fixtures ────────────────────────────────────────────────────────────────
-- One user with a 100-credit balance (a single earn row).
INSERT INTO points_ledger(user_id, delta, status_delta, kind, reason, created_by)
VALUES ('00000000-0000-0000-0000-0000000000aa', 100, 100, 'earn', 'seed', 'test');

-- ── null user → rejected ────────────────────────────────────────────────────
SELECT _assert_eq((redeem_shop_item(NULL, 1)->>'error'), 'null_user', 'null user rejected');

-- ── item not found → rejected ───────────────────────────────────────────────
SELECT _assert_eq((redeem_shop_item('00000000-0000-0000-0000-0000000000aa', 999)->>'error'),
  'item_not_found', 'missing item rejected');

-- ── inactive item → rejected, no spend ──────────────────────────────────────
INSERT INTO shop_items(id, sku, name, type, cost_credits, stock, active) OVERRIDING SYSTEM VALUE
VALUES (10, 'INACTIVE', 'Off Item', 'physical', 10, 5, false);
SELECT _assert_eq((redeem_shop_item('00000000-0000-0000-0000-0000000000aa', 10)->>'error'),
  'item_inactive', 'inactive item rejected');

-- ── out of stock → rejected ─────────────────────────────────────────────────
INSERT INTO shop_items(id, sku, name, type, cost_credits, stock, active) OVERRIDING SYSTEM VALUE
VALUES (11, 'GONE', 'Sold Out', 'physical', 10, 0, true);
SELECT _assert_eq((redeem_shop_item('00000000-0000-0000-0000-0000000000aa', 11)->>'error'),
  'out_of_stock', 'zero-stock item rejected');

-- ── insufficient credits → rejected AND no mutation (the double-spend guard) ──
INSERT INTO shop_items(id, sku, name, type, cost_credits, stock, active) OVERRIDING SYSTEM VALUE
VALUES (12, 'PRICEY', 'Too Dear', 'physical', 500, 5, true);
SELECT _assert_eq((redeem_shop_item('00000000-0000-0000-0000-0000000000aa', 12)->>'error'),
  'insufficient_credits', 'over-balance spend rejected');
SELECT _assert_eq((SELECT count(*)::text FROM points_ledger WHERE kind='spend'), '0',
  'insufficient-credits path writes NO spend row');
SELECT _assert_eq((SELECT count(*)::text FROM redemptions), '0',
  'insufficient-credits path opens NO redemption');
SELECT _assert_eq((SELECT stock::text FROM shop_items WHERE id=12), '5',
  'insufficient-credits path leaves stock untouched');

-- ── status too low → rejected ───────────────────────────────────────────────
INSERT INTO shop_items(id, sku, name, type, cost_credits, stock, min_status, active) OVERRIDING SYSTEM VALUE
VALUES (13, 'VIP', 'Status Gate', 'physical', 10, 5, 500, true);
SELECT _assert_eq((redeem_shop_item('00000000-0000-0000-0000-0000000000aa', 13)->>'error'),
  'status_too_low', 'below-min-status rejected');

-- ── verified-wallet gate → rejected without a verified wallet ────────────────
INSERT INTO shop_items(id, sku, name, type, cost_credits, stock, requires_verified_wallet, active) OVERRIDING SYSTEM VALUE
VALUES (14, 'VER', 'Needs Verify', 'physical', 10, 5, true, true);
SELECT _assert_eq((redeem_shop_item('00000000-0000-0000-0000-0000000000aa', 14)->>'error'),
  'verified_wallet_required', 'unverified-wallet redemption rejected');

-- ── HAPPY PATH: exactly one -cost spend row, balance drops by cost, stock -1 ──
INSERT INTO shop_items(id, sku, name, type, cost_credits, stock, active) OVERRIDING SYSTEM VALUE
VALUES (20, 'CAP', 'RPC Cap', 'physical', 30, 3, true);
SELECT _assert((redeem_shop_item('00000000-0000-0000-0000-0000000000aa', 20)->>'redeemed')::boolean,
  'sufficient credits → redeemed=true');
SELECT _assert_eq((redeem_shop_item('00000000-0000-0000-0000-0000000000aa', 20)->>'error'), NULL,
  'happy path carries no error (2nd redeem still within stock+credits)');
-- Two redeems above (30 each) → balance 100 - 60 = 40, exactly two -30 spend rows.
SELECT _assert_eq((SELECT coalesce(sum(delta),0)::text FROM points_ledger WHERE user_id='00000000-0000-0000-0000-0000000000aa'),
  '40', 'balance = mint 100 − 2×30 spend = 40 (currency conserved)');
SELECT _assert_eq((SELECT count(*)::text FROM points_ledger WHERE kind='spend' AND delta=-30), '2',
  'each redeem writes exactly one -30 spend row');
SELECT _assert_eq((SELECT stock::text FROM shop_items WHERE id=20), '1',
  'stock decremented once per redeem (3 → 1)');
SELECT _assert_eq((SELECT count(*)::text FROM redemptions WHERE shop_item_id=20 AND status='pending'), '2',
  'two pending redemptions opened');

-- ── per_user_limit enforced (limit 1, already redeemed once) ─────────────────
INSERT INTO shop_items(id, sku, name, type, cost_credits, stock, per_user_limit, active) OVERRIDING SYSTEM VALUE
VALUES (21, 'ONCE', 'One Per User', 'physical', 5, 9, 1, true);
SELECT _assert((redeem_shop_item('00000000-0000-0000-0000-0000000000aa', 21)->>'redeemed')::boolean,
  'first redeem under a per_user_limit of 1 succeeds');
SELECT _assert_eq((redeem_shop_item('00000000-0000-0000-0000-0000000000aa', 21)->>'error'),
  'per_user_limit_reached', 'second redeem blocked by per_user_limit');

-- ── raffle type → a raffle_entries row is written ───────────────────────────
INSERT INTO shop_items(id, sku, name, type, cost_credits, stock, active) OVERRIDING SYSTEM VALUE
VALUES (22, 'RAFFLE', 'Prize Draw', 'raffle', 5, NULL, true);
SELECT _assert((redeem_shop_item('00000000-0000-0000-0000-0000000000aa', 22)->>'redeemed')::boolean,
  'raffle redeem succeeds');
SELECT _assert_eq((SELECT count(*)::text FROM raffle_entries WHERE shop_item_id=22), '1',
  'raffle redeem writes one raffle entry');

SELECT '✓ redeem_shop_item invariants pass' AS result;
ROLLBACK;

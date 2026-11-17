-- DB invariant: public.fulfill_redemption(bigint,text,text,text) — the entitlement
-- GRANT side of the rewards trilogy (award_points mints, redeem_shop_item spends,
-- this delivers). It grants/extends Pro (pro_users) or a cosmetic (user_cosmetics /
-- profile_bio) for a redemption and flips it to 'fulfilled'. Pinned properties:
-- redemption-not-found / cancelled rejects; IDEMPOTENCY (an already-fulfilled
-- redemption returns already=true and grants NOTHING — no double Pro); a pro grant
-- with no verified wallet rejects and leaves the redemption pending; a pro grant
-- creates a pro_users row with the metadata-derived duration (default 30d); a
-- SECOND pro grant for the same wallet EXTENDS expiry (greatest(existing,now)+days)
-- rather than resetting; a cosmetic grant writes user_cosmetics + equips the slot.
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20260802000300_audit_20260802_snapshot_fulfill_redemption.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts from it.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE redemptions (
  id           bigint PRIMARY KEY,
  user_id      uuid,
  shop_item_id bigint,
  status       text,
  fulfilled_at timestamptz,
  fulfilled_by text,
  fulfillment  jsonb,
  updated_at   timestamptz DEFAULT now()
);
CREATE TABLE shop_items (
  id       bigint PRIMARY KEY,
  sku      text,
  type     text,
  metadata jsonb
);
CREATE TABLE saved_wallets (
  id          bigint GENERATED ALWAYS AS IDENTITY,
  user_id     uuid,
  wallet_addr text,
  verified_at timestamptz
);
CREATE TABLE pro_users (
  wallet_address text PRIMARY KEY,
  subscribed_at  timestamptz,
  expires_at     timestamptz,
  plan           text,
  granted_by     text,
  grant_reason   text,
  auto_renew     boolean
);
CREATE TABLE user_cosmetics (
  id      bigint GENERATED ALWAYS AS IDENTITY,
  user_id uuid,
  sku     text,
  slot    text,
  value   text,
  UNIQUE (user_id, sku)
);
CREATE TABLE profile_bio (
  user_id         uuid PRIMARY KEY,
  equipped_border text,
  equipped_banner text,
  updated_at      timestamptz
);

-- >>> BEGIN verbatim fulfill_redemption (keep byte-identical to the migration) >>>
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
-- <<< END verbatim fulfill_redemption <<<

-- ── Fixtures ────────────────────────────────────────────────────────────────
INSERT INTO shop_items(id, sku, type, metadata) VALUES
  (100, 'PRO45', 'pro',      '{"grant":"pro_45d"}'),
  (101, 'PRO30', 'pro',      '{"grant":"pro_30d"}'),
  (102, 'PRONM', 'pro',      '{}'),                                  -- no grant → default 30d
  (200, 'BORDER','cosmetic', '{"slot":"border","value":"gold"}');
-- verified wallets: U1 (0xw1), U3 (0xw3), U6 (0xw6). U4 has none.
INSERT INTO saved_wallets(user_id, wallet_addr, verified_at) VALUES
  ('00000000-0000-0000-0000-000000000001','0xW1', now()),
  ('00000000-0000-0000-0000-000000000003','0xW3', now()),
  ('00000000-0000-0000-0000-000000000006','0xW6', now());
INSERT INTO profile_bio(user_id) VALUES ('00000000-0000-0000-0000-000000000005');
INSERT INTO redemptions(id, user_id, shop_item_id, status) VALUES
  (1000,'00000000-0000-0000-0000-000000000001',100,'pending'),  -- U1 pro 45d
  (1001,'00000000-0000-0000-0000-000000000001',101,'pending'),  -- U1 pro 30d (extension, same wallet)
  (1002,'00000000-0000-0000-0000-000000000003',100,'fulfilled'),-- already fulfilled (idempotency)
  (1003,'00000000-0000-0000-0000-000000000004',100,'pending'),  -- U4 no verified wallet
  (1004,'00000000-0000-0000-0000-000000000007',100,'cancelled'),-- cancelled
  (1005,'00000000-0000-0000-0000-000000000005',200,'pending'),  -- U5 cosmetic border
  (1006,'00000000-0000-0000-0000-000000000006',102,'pending');  -- U6 pro default 30d

-- ── not found → rejected ────────────────────────────────────────────────────
SELECT _assert_eq((fulfill_redemption(999999)->>'error'), 'redemption_not_found', 'missing redemption rejected');

-- ── cancelled → rejected ────────────────────────────────────────────────────
SELECT _assert_eq((fulfill_redemption(1004)->>'error'), 'redemption_cancelled', 'cancelled redemption rejected');

-- ── IDEMPOTENCY: already-fulfilled short-circuits and grants nothing ─────────
SELECT _assert_eq((fulfill_redemption(1002)->>'already'), 'true', 'already-fulfilled returns already=true');
SELECT _assert_eq((SELECT count(*)::text FROM pro_users WHERE wallet_address='0xw3'), '0',
  'idempotent re-fulfill grants NO pro row (no double-grant)');

-- ── pro without a verified wallet → rejected, redemption stays pending ───────
SELECT _assert_eq((fulfill_redemption(1003)->>'error'), 'no_verified_wallet', 'no verified wallet rejected');
SELECT _assert_eq((SELECT status FROM redemptions WHERE id=1003), 'pending', 'rejected pro leaves redemption pending');

-- ── pro grant: creates a pro_users row, ~45 days, redemption fulfilled ───────
SELECT _assert_eq((fulfill_redemption(1000)->>'delivered'), 'pro_45d', 'pro grant delivers pro_45d');
SELECT _assert_eq((SELECT count(*)::text FROM pro_users WHERE wallet_address='0xw1'), '1', 'one pro row created');
SELECT _assert((SELECT expires_at > now() + interval '44 days' AND expires_at < now() + interval '46 days'
                FROM pro_users WHERE wallet_address='0xw1'), 'expiry ≈ now + 45 days');
SELECT _assert_eq((SELECT status FROM redemptions WHERE id=1000), 'fulfilled', 'redemption marked fulfilled');
SELECT _assert_eq((SELECT fulfillment->>'delivered' FROM redemptions WHERE id=1000), 'pro_45d',
  'fulfillment json records what was delivered');

-- ── pro EXTENSION: a 2nd grant for the same wallet extends, not resets ───────
SELECT _assert_eq((fulfill_redemption(1001)->>'delivered'), 'pro_30d', '2nd grant delivers pro_30d');
SELECT _assert_eq((SELECT count(*)::text FROM pro_users WHERE wallet_address='0xw1'), '1', 'still one pro row (extended)');
SELECT _assert((SELECT expires_at > now() + interval '74 days' FROM pro_users WHERE wallet_address='0xw1'),
  'expiry EXTENDED to ≈ now + 75 days (greatest(existing,now)+30, not reset to now+30)');

-- ── pro with no grant metadata → default 30 days ────────────────────────────
SELECT _assert_eq((fulfill_redemption(1006)->>'delivered'), 'pro_30d', 'missing grant metadata → default 30d');

-- ── cosmetic: user_cosmetics row + profile_bio equipped ─────────────────────
SELECT _assert_eq((fulfill_redemption(1005)->>'delivered'), 'cosmetic:border:gold', 'cosmetic delivered');
SELECT _assert_eq((SELECT value FROM user_cosmetics WHERE user_id='00000000-0000-0000-0000-000000000005' AND sku='BORDER'),
  'gold', 'user_cosmetics row written');
SELECT _assert_eq((SELECT equipped_border FROM profile_bio WHERE user_id='00000000-0000-0000-0000-000000000005'),
  'gold', 'border slot equipped on profile');

SELECT '✓ fulfill_redemption invariants pass' AS result;
ROLLBACK;

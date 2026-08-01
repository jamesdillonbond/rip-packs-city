-- DB invariant: public.save_user_wallet(text,text,text,text) — the saved-wallet
-- write path. Pinned properties: (a) the wallet address is normalized (lower+trim)
-- everywhere it is stored/returned, (b) topshot_username is lowercased into
-- user_profiles, (c) both upserts are idempotent on their unique keys (no dup
-- rows on re-save), and (d) the honesty property — a re-save with a NULL
-- username/display_name COALESCEs and NEVER nulls out an already-stored value.
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20260801160700_audit_20260801_snapshot_save_user_wallet.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts from it.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE user_profiles (
  id               uuid PRIMARY KEY,
  wallet_address   text UNIQUE,
  topshot_username text,
  display_name     text,
  wallet_saved_at  timestamptz,
  last_active_at   timestamptz,
  updated_at       timestamptz
);
CREATE TABLE saved_wallets (
  owner_key   text,
  wallet_addr text,
  username    text,
  user_id     uuid,
  pinned_at   timestamptz,
  last_viewed timestamptz,
  UNIQUE (owner_key, wallet_addr)
);

-- >>> BEGIN verbatim save_user_wallet (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.save_user_wallet(p_owner_key text, p_wallet_address text, p_topshot_username text DEFAULT NULL::text, p_display_name text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_profile_id UUID;
  v_wallet_norm TEXT;
BEGIN
  v_wallet_norm := lower(trim(p_wallet_address));

  -- Upsert user_profiles keyed on wallet address
  INSERT INTO user_profiles (id, wallet_address, topshot_username, display_name, wallet_saved_at, last_active_at, updated_at)
  VALUES (gen_random_uuid(), v_wallet_norm, lower(p_topshot_username), p_display_name, NOW(), NOW(), NOW())
  ON CONFLICT (wallet_address) DO UPDATE SET
    topshot_username = COALESCE(lower(EXCLUDED.topshot_username), user_profiles.topshot_username),
    display_name = COALESCE(EXCLUDED.display_name, user_profiles.display_name),
    last_active_at = NOW(),
    updated_at = NOW()
  RETURNING id INTO v_profile_id;

  -- If the profile_id came back null (shouldn't happen), fetch it
  IF v_profile_id IS NULL THEN
    SELECT id INTO v_profile_id FROM user_profiles WHERE wallet_address = v_wallet_norm LIMIT 1;
  END IF;

  -- Upsert saved_wallets using the composite unique key (owner_key, wallet_addr)
  INSERT INTO saved_wallets (owner_key, wallet_addr, username, user_id, pinned_at, last_viewed)
  VALUES (p_owner_key, v_wallet_norm, p_topshot_username, v_profile_id, NOW(), NOW())
  ON CONFLICT (owner_key, wallet_addr) DO UPDATE SET
    username = COALESCE(EXCLUDED.username, saved_wallets.username),
    user_id = EXCLUDED.user_id,
    last_viewed = NOW();

  RETURN jsonb_build_object(
    'profile_id', v_profile_id,
    'wallet_address', v_wallet_norm,
    'status', 'saved'
  );
END;
$function$;
-- <<< END verbatim save_user_wallet <<<

-- First save with a messy-cased, padded address + mixed-case username.
SELECT _assert_eq((save_user_wallet('owner1','  0xABCdef  ','TopShotUser','Display')->>'wallet_address'),
  '0xabcdef', 'returned wallet_address is lower+trim normalized');
SELECT _assert_eq((SELECT topshot_username FROM user_profiles WHERE wallet_address='0xabcdef'),
  'topshotuser', 'topshot_username lowercased into profile');
SELECT _assert_eq((SELECT count(*)::text FROM saved_wallets WHERE owner_key='owner1' AND wallet_addr='0xabcdef'),
  '1', 'one saved_wallets row created');

-- Re-save the SAME wallet with NULL username/display → existing values PRESERVED
-- (COALESCE honesty), no duplicate rows created.
SELECT save_user_wallet('owner1','0xABCDEF', NULL, NULL);
SELECT _assert_eq((SELECT topshot_username FROM user_profiles WHERE wallet_address='0xabcdef'),
  'topshotuser', 're-save with NULL username preserves existing profile username');
SELECT _assert_eq((SELECT display_name FROM user_profiles WHERE wallet_address='0xabcdef'),
  'Display', 're-save with NULL display_name preserves existing');
SELECT _assert_eq((SELECT count(*)::text FROM user_profiles WHERE wallet_address='0xabcdef'),
  '1', 'profile upsert is idempotent (no dup)');
SELECT _assert_eq((SELECT count(*)::text FROM saved_wallets WHERE owner_key='owner1' AND wallet_addr='0xabcdef'),
  '1', 'saved_wallets upsert is idempotent on (owner_key, wallet_addr)');
SELECT _assert_eq((SELECT username FROM saved_wallets WHERE owner_key='owner1' AND wallet_addr='0xabcdef'),
  'TopShotUser', 'saved_wallets username preserved on NULL re-save');

-- A DIFFERENT owner saving the SAME wallet → shares the profile, distinct saved row.
SELECT save_user_wallet('owner2','0xabcdef', NULL, NULL);
SELECT _assert_eq((SELECT count(*)::text FROM saved_wallets WHERE wallet_addr='0xabcdef'),
  '2', 'second owner gets its own saved_wallets row for the shared wallet');
SELECT _assert_eq((SELECT count(*)::text FROM user_profiles WHERE wallet_address='0xabcdef'),
  '1', 'still a single shared profile for the wallet');

SELECT '✓ save_user_wallet invariants pass' AS result;
ROLLBACK;

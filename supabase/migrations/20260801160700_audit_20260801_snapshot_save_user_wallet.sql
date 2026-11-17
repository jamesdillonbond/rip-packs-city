-- Snapshot migration: public.save_user_wallet(text,text,text,text).
--
-- Applied to prod historically via the Supabase MCP with no committed migration
-- file (making it UNPINNABLE). This commits the CURRENT LIVE definition verbatim
-- (pulled via pg_get_functiondef on 2026-08-01) so it can carry a pinned
-- invariant test. Applying it is a no-op against prod (byte-identical).
--
-- What it does: the saved-wallet write path. It normalizes the wallet address
-- (lower+trim), upserts user_profiles keyed on wallet_address and saved_wallets
-- keyed on (owner_key, wallet_addr), and — the honesty property — COALESCEs on
-- conflict so a re-save with a NULL username/display_name never NULLS OUT an
-- already-stored value.

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

-- audit_20261031_record_feature_usage_sets_user_id
--
-- 2026-10-31 (Cowork, activity review follow-up). Concierge quota rows written by
-- record_feature_usage carried no user_id, so user_activity showed a signed-in
-- user's concierge messages as ANONYMOUS (the founder's 10-24 QA battery read as
-- 19 anon rows in the two-week report). Since 133e014 a wallet-less signed-in
-- account is metered as `user:<auth uuid>`; that key now also stamps user_id, so
-- the row is attributed. Wallet keys are unchanged (no wallet→user guess here).
-- Same signature, SECURITY DEFINER and search_path as before, so ACLs are preserved.
-- anon-exec: intentional — same signature keeps the existing ACL: anon/authenticated EXECUTE false, service_role true (record_feature_usage)
--
-- Revert: re-create with the previous body (prosrc md5 de73eb5dc882847321bf6aaed978e8c5):
--   INSERT INTO usage_events (wallet_address, feature_name, metadata)
--   VALUES (lower(trim(p_wallet)), p_feature, p_metadata) RETURNING id INTO v_id; RETURN v_id;

CREATE OR REPLACE FUNCTION public.record_feature_usage(p_wallet text, p_feature text, p_metadata jsonb DEFAULT NULL::jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_id uuid;
  v_key text := lower(trim(p_wallet));
  v_user uuid;
BEGIN
  IF v_key ~ '^user:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    v_user := substr(v_key, 6)::uuid;
    -- only an existing account; a stale or forged id stays unattributed
    IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = v_user) THEN
      v_user := NULL;
    END IF;
  END IF;
  INSERT INTO usage_events (wallet_address, feature_name, metadata, user_id)
  VALUES (v_key, p_feature, p_metadata, v_user)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$function$;

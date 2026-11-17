-- DB invariant: public.resolve_channel_owner(text,text) — resolves an inbound
-- notification channel (a Telegram/Discord user) to the RPC account that owns it.
-- This is the ROUTING + TRUST boundary for channel commands, so its SECURITY
-- property is load-bearing: it resolves an owner ONLY for a row with
-- verified = true (an unverified — or verified-NULL — channel link must return
-- linked:false and NEVER surface an owner_key), keyed on the exact
-- (channel, channel_user_id) pair; a successful resolution stamps last_used_at,
-- an unresolved one touches nothing.
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20260801230300_audit_20260801_snapshot_resolve_channel_owner.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts, and the
-- md5 of pg_get_functiondef was confirmed byte-identical to LIVE prod on 2026-08-01
-- (71f639b9efc7495b729feda891fa22c4).
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE notification_channels (
  channel         text,
  channel_user_id text,
  owner_key       text,
  verified        boolean,
  last_used_at    timestamptz
);

-- >>> BEGIN verbatim resolve_channel_owner (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.resolve_channel_owner(p_channel text, p_channel_user_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_owner text;
BEGIN
  SELECT owner_key INTO v_owner FROM public.notification_channels
  WHERE channel = p_channel AND channel_user_id = p_channel_user_id AND verified = true;

  IF v_owner IS NULL THEN
    RETURN jsonb_build_object('linked', false);
  END IF;

  UPDATE public.notification_channels
  SET last_used_at = now()
  WHERE channel = p_channel AND channel_user_id = p_channel_user_id;

  RETURN jsonb_build_object('linked', true, 'owner_key', v_owner);
END;
$function$;
-- <<< END verbatim resolve_channel_owner <<<

-- Seed: one verified link, one unverified link, one verified-NULL link.
INSERT INTO notification_channels (channel, channel_user_id, owner_key, verified, last_used_at) VALUES
  ('telegram', 'tg_verified',   'owner_a', true,  NULL),
  ('telegram', 'tg_unverified', 'owner_b', false, NULL),
  ('discord',  'dc_nullver',    'owner_c', NULL,  NULL);

-- 1) VERIFIED match → linked:true + owner_key, and last_used_at gets stamped.
SELECT _assert_eq(
  (resolve_channel_owner('telegram','tg_verified')->>'owner_key'), 'owner_a',
  'verified channel resolves to its owner_key');
SELECT _assert_eq(
  (resolve_channel_owner('telegram','tg_verified')->>'linked'), 'true',
  'verified channel → linked:true');
SELECT _assert_eq(
  (SELECT (last_used_at IS NOT NULL)::text FROM notification_channels WHERE channel_user_id='tg_verified'),
  'true', 'a successful resolution stamps last_used_at');

-- 2) UNVERIFIED row → linked:false, owner_key NOT surfaced, last_used_at untouched.
SELECT _assert_eq(
  (resolve_channel_owner('telegram','tg_unverified')->>'linked'), 'false',
  'unverified channel → linked:false (the security boundary)');
SELECT _assert(
  (resolve_channel_owner('telegram','tg_unverified')->'owner_key') IS NULL,
  'unverified channel never surfaces an owner_key');
SELECT _assert_eq(
  (SELECT (last_used_at IS NULL)::text FROM notification_channels WHERE channel_user_id='tg_unverified'),
  'true', 'an unresolved channel does NOT stamp last_used_at');

-- 3) verified = NULL is NOT true → linked:false (NULL must not pass the gate).
SELECT _assert_eq(
  (resolve_channel_owner('discord','dc_nullver')->>'linked'), 'false',
  'verified NULL is not verified true → linked:false');

-- 4) No matching row / wrong id / wrong channel → linked:false.
SELECT _assert_eq((resolve_channel_owner('telegram','nobody')->>'linked'), 'false',
  'unknown channel_user_id → linked:false');
SELECT _assert_eq((resolve_channel_owner('discord','tg_verified')->>'linked'), 'false',
  'right user_id on the WRONG channel → linked:false (both keys must match)');

SELECT '✓ resolve_channel_owner invariants pass' AS result;
ROLLBACK;

-- DB invariant: public.get_owner_channel_targets(text,text) — the SEND side of the
-- channel-routing pair (resolve_channel_owner is the receive side). Given an RPC
-- owner it returns the notification targets (Telegram/Discord) an alert should go
-- to. Load-bearing SECURITY property: it returns ONLY verified = true channels
-- with a non-null channel_user_id (never an unverified or half-linked channel),
-- scoped to that owner, optionally narrowed to a single channel; an empty result
-- is '[]', never NULL.
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20260801230500_audit_20260801_snapshot_get_owner_channel_targets.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts, and the
-- md5 of pg_get_functiondef was confirmed byte-identical to LIVE prod on 2026-08-01
-- (14c765c1f7b36fabe4632def2e23a559).
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE notification_channels (
  owner_key        text,
  channel          text,
  channel_user_id  text,
  channel_username text,
  verified         boolean
);

-- >>> BEGIN verbatim get_owner_channel_targets (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.get_owner_channel_targets(p_owner_key text, p_channel text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'channel', channel,
           'channel_user_id', channel_user_id,
           'channel_username', channel_username
         )), '[]'::jsonb)
  FROM public.notification_channels
  WHERE owner_key = p_owner_key
    AND verified = true
    AND channel_user_id IS NOT NULL
    AND (p_channel IS NULL OR channel = p_channel);
$function$;
-- <<< END verbatim get_owner_channel_targets <<<

-- Owner A: a verified telegram, a verified discord, an UNVERIFIED telegram, and a
-- verified-but-null-user_id row. Owner B: a verified telegram (must not leak into A).
INSERT INTO notification_channels (owner_key, channel, channel_user_id, channel_username, verified) VALUES
  ('owner_a', 'telegram', 'tg_a',  '@tga',  true),
  ('owner_a', 'discord',  'dc_a',  'dca#1', true),
  ('owner_a', 'telegram', 'tg_ax', '@tgax', false),  -- unverified → excluded
  ('owner_a', 'discord',  NULL,    'half',  true),    -- null user_id → excluded
  ('owner_b', 'telegram', 'tg_b',  '@tgb',  true);    -- other owner → excluded

-- 1) All targets for owner A: exactly the 2 verified, non-null rows.
SELECT _assert_eq(
  jsonb_array_length(get_owner_channel_targets('owner_a'))::text, '2',
  'returns exactly the verified, non-null channels for the owner');

-- 2) SECURITY: the unverified telegram is NOT in the set (only tg_a is telegram).
SELECT _assert_eq(
  (SELECT count(*)::text FROM jsonb_array_elements(get_owner_channel_targets('owner_a')) e
     WHERE e->>'channel_user_id' = 'tg_ax'),
  '0', 'unverified channel is never a delivery target');

-- 3) channel filter narrows to one channel.
SELECT _assert_eq(
  jsonb_array_length(get_owner_channel_targets('owner_a', 'telegram'))::text, '1',
  'channel filter narrows to that channel only');
SELECT _assert_eq(
  (get_owner_channel_targets('owner_a', 'telegram')->0->>'channel_user_id'), 'tg_a',
  'the one telegram target is the verified tg_a with its element shape');

-- 4) No cross-owner leak; unknown owner → '[]' (not NULL).
SELECT _assert_eq(
  (SELECT count(*)::text FROM jsonb_array_elements(get_owner_channel_targets('owner_a')) e
     WHERE e->>'channel_user_id' = 'tg_b'),
  '0', 'another owner''s channel never leaks');
SELECT _assert_eq(get_owner_channel_targets('nobody')::text, '[]',
  'unknown owner returns an empty array, never NULL');
SELECT _assert_eq(get_owner_channel_targets('owner_a', 'reddit')::text, '[]',
  'a channel the owner has no verified target on returns []');

SELECT '✓ get_owner_channel_targets invariants pass' AS result;
ROLLBACK;

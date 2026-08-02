-- DB invariant: public.check_feature_quota(text, text) → jsonb — the per-wallet
-- daily feature-quota gate (Pro entitlements). Pins: an unconfigured plan/feature
-- FAILS OPEN; a NULL limit is unlimited; otherwise allowed = (24h usage < limit)
-- with correct used_today/remaining/reason; usage older than 24h is excluded; and
-- the wallet is matched case-insensitively. get_user_plan is STUBBED (it has its
-- own resolution logic) so this test isolates the quota math.
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20260802190500_audit_20260802_snapshot_check_feature_quota.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts from it.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE feature_quotas (
  feature_name text,
  plan         text,
  daily_limit  integer
);

CREATE TABLE usage_events (
  wallet_address text,
  feature_name   text,
  occurred_at    timestamptz
);

CREATE TABLE _plans (wallet text, plan text);

-- Stub get_user_plan (pinned elsewhere): map a fixture wallet → plan, default free.
CREATE OR REPLACE FUNCTION public.get_user_plan(w text) RETURNS text
  LANGUAGE sql STABLE AS $g$ SELECT coalesce((SELECT plan FROM _plans WHERE wallet = w), 'free') $g$;

-- >>> BEGIN verbatim check_feature_quota (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.check_feature_quota(p_wallet text, p_feature text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_plan text;
  v_limit integer;
  v_used integer;
  v_wallet_lower text := lower(trim(p_wallet));
BEGIN
  -- Resolve plan (defaults to 'free' if no active pro_users row)
  v_plan := get_user_plan(v_wallet_lower);

  -- Look up the daily limit for this plan/feature
  SELECT daily_limit INTO v_limit
  FROM feature_quotas
  WHERE feature_name = p_feature AND plan = v_plan;

  -- If no quota row exists, treat as unlimited (fail open) but flag in response
  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'allowed', true, 'plan', v_plan, 'daily_limit', NULL,
      'used_today', 0, 'remaining', NULL,
      'reason', 'no_quota_configured_failing_open'
    );
  END IF;

  -- NULL limit = unlimited
  IF v_limit IS NULL THEN
    RETURN jsonb_build_object(
      'allowed', true, 'plan', v_plan, 'daily_limit', NULL,
      'used_today', 0, 'remaining', NULL,
      'reason', 'unlimited'
    );
  END IF;

  -- Count usage in last 24h
  SELECT COUNT(*) INTO v_used
  FROM usage_events
  WHERE wallet_address = v_wallet_lower
    AND feature_name = p_feature
    AND occurred_at > NOW() - INTERVAL '24 hours';

  RETURN jsonb_build_object(
    'allowed', v_used < v_limit,
    'plan', v_plan,
    'daily_limit', v_limit,
    'used_today', v_used,
    'remaining', GREATEST(0, v_limit - v_used),
    'reason', CASE
      WHEN v_used < v_limit THEN 'within_quota'
      ELSE 'daily_limit_reached'
    END
  );
END;
$function$;
-- <<< END verbatim check_feature_quota <<<

INSERT INTO feature_quotas (feature_name, plan, daily_limit) VALUES
  ('fmv_lookup', 'free', 3),
  ('fmv_lookup', 'pro',  NULL);   -- pro = unlimited
INSERT INTO _plans (wallet, plan) VALUES ('0xpro', 'pro');  -- 0xfree* default to 'free'

-- Unconfigured plan/feature → FAIL OPEN.
SELECT _assert_eq(check_feature_quota('0xfree1', 'unknown_feature')->>'allowed', 'true', 'no quota row → allowed (fail open)');
SELECT _assert_eq(check_feature_quota('0xfree1', 'unknown_feature')->>'reason', 'no_quota_configured_failing_open', 'fail-open reason surfaced');

-- Pro plan with NULL limit → unlimited.
SELECT _assert_eq(check_feature_quota('0xpro', 'fmv_lookup')->>'reason', 'unlimited', 'NULL limit → unlimited');
SELECT _assert_eq(check_feature_quota('0xpro', 'fmv_lookup')->>'plan', 'pro', 'resolved plan echoed');

-- Under quota: 2 recent uses + 5 OLD (25h) uses that must be excluded; limit 3.
INSERT INTO usage_events (wallet_address, feature_name, occurred_at) VALUES
  ('0xfree1', 'fmv_lookup', now() - interval '1 hour'),
  ('0xfree1', 'fmv_lookup', now() - interval '2 hours'),
  ('0xfree1', 'fmv_lookup', now() - interval '25 hours'),
  ('0xfree1', 'fmv_lookup', now() - interval '26 hours'),
  ('0xfree1', 'fmv_lookup', now() - interval '30 hours'),
  ('0xfree1', 'fmv_lookup', now() - interval '48 hours'),
  ('0xfree1', 'fmv_lookup', now() - interval '72 hours');
-- Call with UPPERCASE wallet → matches the lowercase-stored usage (case-insensitive).
SELECT _assert_eq(check_feature_quota('0xFREE1', 'fmv_lookup')->>'used_today', '2', '24h window counts only the 2 recent uses (case-insensitive)');
SELECT _assert_eq(check_feature_quota('0xFREE1', 'fmv_lookup')->>'allowed', 'true', 'under limit → allowed');
SELECT _assert_eq(check_feature_quota('0xFREE1', 'fmv_lookup')->>'remaining', '1', 'remaining = limit - used');
SELECT _assert_eq(check_feature_quota('0xFREE1', 'fmv_lookup')->>'reason', 'within_quota', 'within_quota reason');

-- At the limit: exactly 3 recent uses → allowed false, remaining 0.
INSERT INTO usage_events (wallet_address, feature_name, occurred_at) VALUES
  ('0xfree2', 'fmv_lookup', now() - interval '1 hour'),
  ('0xfree2', 'fmv_lookup', now() - interval '2 hours'),
  ('0xfree2', 'fmv_lookup', now() - interval '3 hours');
SELECT _assert_eq(check_feature_quota('0xfree2', 'fmv_lookup')->>'allowed', 'false', 'at limit → not allowed');
SELECT _assert_eq(check_feature_quota('0xfree2', 'fmv_lookup')->>'remaining', '0', 'at limit → remaining 0');
SELECT _assert_eq(check_feature_quota('0xfree2', 'fmv_lookup')->>'reason', 'daily_limit_reached', 'daily_limit_reached reason');

SELECT '✓ check_feature_quota invariants pass' AS result;
ROLLBACK;

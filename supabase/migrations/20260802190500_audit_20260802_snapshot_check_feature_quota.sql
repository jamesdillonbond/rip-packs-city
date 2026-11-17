-- Snapshot migration: public.check_feature_quota(text, text).
--
-- MCP-applied to prod with no committed migration → UNPINNABLE. This commits the
-- CURRENT LIVE body verbatim (pg_get_functiondef 2026-08-02) so it can carry a
-- drift-guarded pinned test. Applying it is a no-op vs prod (byte-identical).
--
-- The per-wallet daily feature-quota gate (Pro entitlements). Resolves the
-- wallet's plan, looks up the plan/feature daily_limit, and reports allowed =
-- (24h usage < limit). Two deliberate escape hatches: an unconfigured
-- plan/feature FAILS OPEN (never blocks a user because ops forgot a row), and a
-- NULL limit means unlimited. A regression that failed closed would lock paying
-- users out of features; one that miscounted the 24h window would give away or
-- wrongly deny paid quota.
--
-- Pinned by supabase/tests/check_feature_quota.sql (which stubs get_user_plan).

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

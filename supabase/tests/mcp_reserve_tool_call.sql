-- DB invariant: public.mcp_reserve_tool_call(text, text) + public.mcp_log_tool_detail(text, text, jsonb)
-- — the MCP worker's ATOMIC quota (security audit 2026-10-25, register R138(a)).
--
-- The old shape was check-then-log: the worker read check_feature_quota at
-- request start and wrote the counted `mcp_query` row afterwards, so parallel
-- calls all read the same used_today and all passed. mcp_reserve_tool_call
-- checks and counts in one transaction under a per-wallet advisory lock.
--
-- ⚠ WHAT THIS FILE CANNOT SHOW: concurrency. A single psql session cannot race
-- itself, so the lock is pinned by EXISTENCE (prosrc carries
-- pg_advisory_xact_lock) and the counting behaviour is pinned sequentially —
-- a reservation is counted by the very next check, and a denied call writes
-- nothing (so a client hammering at the cap cannot inflate its own count).
--
-- The DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20261025232432_audit_20261025_mcp_reserve_tool_call_atomic_quota.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE usage_events (
  wallet_address text,
  feature_name   text,
  metadata       jsonb,
  occurred_at    timestamptz DEFAULT now()
);

CREATE TABLE feature_quotas (
  feature_name text,
  plan         text,
  daily_limit  integer
);

-- check_feature_quota, reduced to the counting behaviour this test depends on
-- (the full function is pinned by supabase/tests/check_feature_quota.sql).
CREATE OR REPLACE FUNCTION public.check_feature_quota(p_wallet text, p_feature text)
RETURNS jsonb LANGUAGE plpgsql STABLE AS $q$
DECLARE v_limit integer; v_used integer; v_w text := lower(trim(p_wallet));
BEGIN
  SELECT daily_limit INTO v_limit FROM feature_quotas
   WHERE feature_name = p_feature AND plan = 'free';
  IF NOT FOUND THEN
    RETURN jsonb_build_object('allowed', true, 'used_today', 0,
                              'reason', 'no_quota_configured_failing_open');
  END IF;
  SELECT count(*) INTO v_used FROM usage_events
   WHERE wallet_address = v_w AND feature_name = p_feature
     AND occurred_at > now() - interval '24 hours';
  RETURN jsonb_build_object('allowed', v_used < v_limit, 'used_today', v_used,
                            'reason', CASE WHEN v_used < v_limit THEN 'within_quota'
                                           ELSE 'daily_limit_reached' END);
END $q$;

-- >>> BEGIN verbatim mcp_reserve_tool_call (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.mcp_reserve_tool_call(p_wallet_address text, p_tool_name text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_wallet text := lower(trim(p_wallet_address));
  v_quota  jsonb;
begin
  -- One reservation at a time per wallet. The quota read below runs after the
  -- lock is held, so it sees every reservation committed by an earlier holder.
  perform pg_advisory_xact_lock(hashtextextended('mcp_quota:' || v_wallet, 0));

  v_quota := public.check_feature_quota(v_wallet, 'mcp_query');

  if coalesce((v_quota->>'allowed')::boolean, false) then
    insert into public.usage_events(wallet_address, feature_name, metadata)
      values (v_wallet, 'mcp_query', jsonb_build_object('tool', p_tool_name, 'reserved', true));
  end if;

  return v_quota;
end;
$function$;
-- <<< END verbatim mcp_reserve_tool_call <<<

-- >>> BEGIN verbatim mcp_log_tool_detail (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.mcp_log_tool_detail(p_wallet_address text, p_tool_name text, p_metadata jsonb DEFAULT '{}'::jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  insert into public.usage_events(wallet_address, feature_name, metadata)
    values (lower(trim(p_wallet_address)), 'mcp_' || p_tool_name, coalesce(p_metadata, '{}'::jsonb));
end;
$function$;
-- <<< END verbatim mcp_log_tool_detail <<<

INSERT INTO feature_quotas (feature_name, plan, daily_limit) VALUES ('mcp_query', 'free', 2);

-- ── A reservation is counted by the very next check ─────────────────────────
SELECT _assert_eq(mcp_reserve_tool_call('0xW1', 'get_fmv')->>'allowed', 'true', '1st call allowed');
SELECT _assert_eq(check_feature_quota('0xw1', 'mcp_query')->>'used_today', '1',
  'the reservation itself is the counted row — no separate log step needed');
SELECT _assert_eq(mcp_reserve_tool_call('0xw1', 'lookup_wallet')->>'used_today', '1',
  '2nd call reads the 1st reservation (it returns the count BEFORE reserving)');
SELECT _assert_eq(check_feature_quota('0xw1', 'mcp_query')->>'used_today', '2', 'two reserved');

-- ── At the cap: denied, and a denial writes NOTHING ─────────────────────────
SELECT _assert_eq(mcp_reserve_tool_call('0xw1', 'get_fmv')->>'allowed', 'false', '3rd call denied at limit 2');
SELECT _assert_eq(mcp_reserve_tool_call('0xw1', 'get_fmv')->>'reason', 'daily_limit_reached', 'and says why');
SELECT _assert_eq(
  (SELECT count(*)::text FROM usage_events WHERE feature_name = 'mcp_query'), '2',
  'denied calls do not inflate the count');
SELECT _assert_eq(
  (SELECT metadata->>'tool' FROM usage_events WHERE feature_name = 'mcp_query' ORDER BY occurred_at LIMIT 1), 'get_fmv',
  'the reservation keeps the tool name');

-- Another wallet is unaffected.
SELECT _assert_eq(mcp_reserve_tool_call('0xw2', 'get_fmv')->>'allowed', 'true', 'per-wallet, not global');

-- ── The detail logger writes only the per-tool row ──────────────────────────
SELECT mcp_log_tool_detail('0xW1', 'get_fmv', '{"duration_ms": 7}'::jsonb);
SELECT _assert_eq(
  (SELECT count(*)::text FROM usage_events WHERE feature_name = 'mcp_get_fmv' AND wallet_address = '0xw1'), '1',
  'one per-tool row, lowercased wallet');
SELECT _assert_eq(
  (SELECT count(*)::text FROM usage_events WHERE feature_name = 'mcp_query' AND wallet_address = '0xw1'), '2',
  'and NO extra quota row (the reservation already counted the call)');

-- ── The lock exists (concurrency itself cannot be raced from one session) ───
SELECT _assert(
  (SELECT prosrc FROM pg_proc WHERE proname = 'mcp_reserve_tool_call') LIKE '%pg_advisory_xact_lock%',
  'check-and-count is serialised per wallet');

SELECT '✓ mcp_reserve_tool_call invariants pass' AS result;
ROLLBACK;

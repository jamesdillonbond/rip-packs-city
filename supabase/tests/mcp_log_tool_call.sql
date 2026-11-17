-- DB invariant: public.mcp_log_tool_call(text, text, jsonb) — the MCP worker's
-- per-call usage writer. Pins the property the whole thing exists for: the key
-- the QUOTA counts is a key this function WRITES.
--
-- ⭐ THE DEFECT, 2026-09-03. `check_feature_quota(wallet, feature)` counts
-- `usage_events WHERE feature_name = p_feature` EXACTLY, and the worker gates
-- every authed request on `p_feature = 'mcp_query'`. This function wrote only
-- `'mcp_' || p_tool_name`, so a call landed as `mcp_get_fmv` and the counted key
-- was written by nothing at all. `used_today` was pinned at 0, `allowed` was
-- always true, and the daily cap could not fire for ANY plan — including `free`
-- and its 100/day cap, which is the anonymous-abuse surface.
--
-- 🚨 WHY IT SURVIVED: the failure is SILENT IN THE DIRECTION OF PERMISSION. A
-- limiter that never fires is indistinguishable from a limiter nobody has hit —
-- the request 200s, the quota RPC answers `allowed:true`, nothing is logged.
-- The two observations an operator naturally makes cannot tell them apart, so
-- the assertion below is on `used_today` RISING, never on a 200 coming back.
--
-- ⚠ TWO ROWS PER CALL IS THE DESIGN, not an accident: one per-tool row for the
-- `v_mcp_usage_today` breakdown (shape unchanged) and one `mcp_query` row for
-- the counter. The view therefore has to EXCLUDE the quota row or every per-tool
-- number doubles — pinned here too, because that exclusion is the kind of thing
-- a later `CREATE OR REPLACE VIEW` drops without noticing.
--
-- The DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20260903164254_audit_20260903_mcp_log_tool_call_writes_the_quota_key.sql);
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

CREATE TABLE _plans (wallet text, plan text);

-- Stub get_user_plan (pinned in check_feature_quota.sql): fixture wallet → plan.
CREATE OR REPLACE FUNCTION public.get_user_plan(w text) RETURNS text
  LANGUAGE sql STABLE AS $g$ SELECT coalesce((SELECT plan FROM _plans WHERE wallet = w), 'free') $g$;

-- check_feature_quota, reduced to the counting behaviour this test depends on.
-- ⚠ NOT a verbatim copy and deliberately so — the full function is pinned by
-- supabase/tests/check_feature_quota.sql, and duplicating it here would mean two
-- copies to keep in step for no extra coverage. What matters to THIS test is
-- only that it counts `feature_name = p_feature` over 24h, which is what this
-- reproduces.
CREATE OR REPLACE FUNCTION public.check_feature_quota(p_wallet text, p_feature text)
RETURNS jsonb LANGUAGE plpgsql STABLE AS $q$
DECLARE v_plan text; v_limit integer; v_used integer; v_w text := lower(trim(p_wallet));
BEGIN
  v_plan := get_user_plan(v_w);
  SELECT daily_limit INTO v_limit FROM feature_quotas
   WHERE feature_name = p_feature AND plan = v_plan;
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

-- >>> BEGIN verbatim mcp_log_tool_call (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.mcp_log_tool_call(p_wallet_address text, p_tool_name text, p_metadata jsonb DEFAULT '{}'::jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_wallet text  := lower(trim(p_wallet_address));
  v_meta   jsonb := coalesce(p_metadata, '{}'::jsonb);
begin
  -- (1) per-tool row — the observability breakdown, shape unchanged.
  insert into public.usage_events(wallet_address, feature_name, metadata)
    values (v_wallet, 'mcp_' || p_tool_name, v_meta);

  -- (2) the QUOTA row. check_feature_quota counts feature_name = p_feature
  -- exactly, and the worker checks 'mcp_query'. Without this the daily cap is
  -- inert for every plan. The tool name is kept in metadata so nothing is lost
  -- by the extra row.
  insert into public.usage_events(wallet_address, feature_name, metadata)
    values (v_wallet, 'mcp_query', v_meta || jsonb_build_object('tool', p_tool_name));
end;
$function$;
-- <<< END verbatim mcp_log_tool_call <<<

-- >>> BEGIN verbatim v_mcp_usage_today (keep byte-identical to the migration) >>>
create or replace view public.v_mcp_usage_today
with (security_invoker = on)
as
select
  date_trunc('hour', occurred_at) as bucket,
  wallet_address,
  feature_name,
  count(*) as call_count,
  count(*) filter (where (metadata->>'cache_hit')::boolean is true) as cache_hits,
  count(*) filter (where (metadata->>'error') is not null) as errors
  from public.usage_events
 where feature_name like 'mcp\_%' escape '\'
   and feature_name <> 'mcp_query'   -- the quota counter, not a tool call
   and occurred_at >= now() - interval '24 hours'
 group by 1, 2, 3;
-- <<< END verbatim v_mcp_usage_today <<<

INSERT INTO feature_quotas (feature_name, plan, daily_limit) VALUES ('mcp_query', 'free', 3);

-- ── The property, stated as the thing that was false ────────────────────────
SELECT _assert_eq(check_feature_quota('0xw1', 'mcp_query')->>'used_today', '0',
  'baseline: no calls yet');

SELECT mcp_log_tool_call('0xW1', 'get_fmv', '{"duration_ms": 12}'::jsonb);

-- ⭐ THE ASSERTION THE OLD FUNCTION FAILS. Before the fix this stayed at 0
-- forever, so `allowed` was permanently true and the cap was decorative.
SELECT _assert_eq(check_feature_quota('0xw1', 'mcp_query')->>'used_today', '1',
  'a tool call is COUNTED by the quota (the whole defect)');

-- The per-tool row still exists and still carries the caller-supplied metadata.
SELECT _assert_eq(
  (SELECT count(*)::text FROM usage_events WHERE feature_name = 'mcp_get_fmv'), '1',
  'the per-tool observability row is still written');
SELECT _assert_eq(
  (SELECT metadata->>'duration_ms' FROM usage_events WHERE feature_name = 'mcp_get_fmv'), '12',
  'caller metadata survives on the per-tool row');
SELECT _assert_eq(
  (SELECT metadata->>'tool' FROM usage_events WHERE feature_name = 'mcp_query'), 'get_fmv',
  'the quota row keeps the tool name, so the extra row loses nothing');

-- Wallet is lowercased on write, as before, so an uppercase check still matches.
SELECT _assert_eq(
  (SELECT count(DISTINCT wallet_address)::text FROM usage_events), '1',
  'both rows are written under the same lowercased wallet');

-- ── The cap actually FIRES, which is the point of counting ──────────────────
SELECT mcp_log_tool_call('0xw1', 'lookup_wallet', '{}'::jsonb);
SELECT _assert_eq(check_feature_quota('0xw1', 'mcp_query')->>'allowed', 'true',
  'under the limit → still allowed (positive control)');
SELECT mcp_log_tool_call('0xw1', 'get_badge_data', '{}'::jsonb);
SELECT _assert_eq(check_feature_quota('0xw1', 'mcp_query')->>'used_today', '3',
  'three calls counted');
SELECT _assert_eq(check_feature_quota('0xw1', 'mcp_query')->>'allowed', 'false',
  'AT the limit → blocked. This is the outcome the defect made unreachable.');
SELECT _assert_eq(check_feature_quota('0xw1', 'mcp_query')->>'reason', 'daily_limit_reached',
  'and it says why');

-- A different wallet is unaffected — the count is per-wallet, not global.
SELECT _assert_eq(check_feature_quota('0xw2', 'mcp_query')->>'allowed', 'true',
  'another wallet is not charged for the first one''s calls');

-- ── The view must not double-count the quota row ────────────────────────────
SELECT _assert_eq(
  (SELECT coalesce(sum(call_count), 0)::text FROM v_mcp_usage_today), '3',
  'the breakdown counts 3 TOOL calls, not 6 — the quota row is excluded');
SELECT _assert(
  NOT EXISTS (SELECT 1 FROM v_mcp_usage_today WHERE feature_name = 'mcp_query'),
  'the quota counter is not a tool and must not appear as one in the breakdown');
SELECT _assert_eq(
  (SELECT count(DISTINCT feature_name)::text FROM v_mcp_usage_today), '3',
  'three distinct tools in the breakdown');

-- ⚠ `security_invoker` is not decorative: without it the view runs as its owner
-- and hands every caller everyone else's usage. A bare CREATE OR REPLACE VIEW
-- resets reloptions and drops it silently, which has happened four times here.
SELECT _assert(
  (SELECT reloptions FROM pg_class WHERE oid = 'public.v_mcp_usage_today'::regclass)
    @> ARRAY['security_invoker=on'],
  'v_mcp_usage_today kept security_invoker=on through the replace');

SELECT '✓ mcp_log_tool_call invariants pass' AS result;
ROLLBACK;

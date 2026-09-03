-- audit_20260903: mcp_log_tool_call must write the key the quota COUNTS.
--
-- `check_feature_quota(wallet, feature)` counts `usage_events WHERE feature_name
-- = p_feature` EXACTLY, and the MCP worker gates every authed request on
-- `p_feature = 'mcp_query'`. Nothing writes that key: this function wrote
-- `'mcp_' || p_tool_name`, so a call landed as `mcp_get_fmv`, `mcp_lookup_wallet`
-- and so on. `used_today` was therefore pinned at 0 and `allowed` was always
-- true — the cap could not fire for ANY plan, including `free` and its 100/day
-- cap, which is the anonymous-abuse surface.
--
-- Fixed HERE rather than in the Worker deliberately: the Worker already calls
-- this function on every tool call, and a Worker change needs a `wrangler
-- deploy` that no sandbox session can run. A DB fix ships through the same path
-- as every other migration.
--
-- ⚠ TWO ROWS PER CALL, ON PURPOSE. The per-tool row is the observability
-- breakdown `v_mcp_usage_today` groups on and its shape is UNCHANGED; the
-- `mcp_query` row is the quota counter. Collapsing them into one row keyed
-- `mcp_query` with the tool in metadata was the alternative and was rejected:
-- the view would have to group on `metadata->>'tool'`, i.e. RENAME a column,
-- which `CREATE OR REPLACE VIEW` cannot do (42P16) — it needs a DROP + CREATE
-- against a view that has grants.
--
-- ⚠ The view must then EXCLUDE the quota row or every per-tool breakdown double
-- counts. `'mcp_query'` matches its own `mcp\_%` filter.

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

-- ⚠ ALL THREE ROLES IN ONE STATEMENT. The 2026-05 original said `from public`
-- alone, and this migration copied it verbatim before
-- `__tests__/migration-new-function-states-its-anon-exec-decision.test.ts`
-- caught it: this DB carries a PUBLIC default AND `ALTER DEFAULT PRIVILEGES`
-- grants, so a PUBLIC-only revoke can leave the explicit anon/authenticated
-- rows in place. Corrected here after the apply and re-run against prod;
-- `has_function_privilege` reads anon=false, authenticated=false,
-- service_role=true both before and after, so this closed the ACL explicitly
-- rather than fixing a live exposure — `CREATE OR REPLACE FUNCTION` does not
-- reset a function ACL, so the 2026-05 grants carried through untouched.
revoke all on function public.mcp_log_tool_call(text, text, jsonb) from public, anon, authenticated;
grant execute on function public.mcp_log_tool_call(text, text, jsonb) to service_role;

-- ⚠ `security_invoker=on` is re-asserted in the WITH clause. A bare
-- `CREATE OR REPLACE VIEW` RESETS reloptions and silently strips it (four
-- occurrences in this repo's history). Column names, order and types are
-- unchanged, so 42P16 does not apply.
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

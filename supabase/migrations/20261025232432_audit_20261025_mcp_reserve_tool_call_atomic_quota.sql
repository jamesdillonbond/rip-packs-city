-- audit_20261025_mcp_reserve_tool_call_atomic_quota
--
-- Security audit 2026-10-25, register R138(a): the MCP worker's daily quota was
-- CHECK-THEN-LOG. It read `check_feature_quota(wallet,'mcp_query')` at request
-- start and wrote the `mcp_query` row afterwards, in `ctx.waitUntil`, so N
-- parallel tool calls all read the same `used_today` and all passed — a key on
-- the 100/day free plan could exceed it by its own concurrency.
--
-- `mcp_reserve_tool_call` makes check-and-count one step: it takes a per-wallet
-- transaction advisory lock, reads the quota, and inserts the `mcp_query` row in
-- the same transaction when allowed. Parallel calls for one wallet queue on the
-- lock, and each reads a count that includes every reservation committed before
-- it. The lock is released when PostgREST commits the RPC.
--
-- `mcp_log_tool_detail` writes ONLY the per-tool observability row
-- (`'mcp_' || tool`), because the reservation already wrote the counted row.
--
-- ⚠ ADDITIVE. `mcp_log_tool_call` is left untouched: the worker deployed today
-- still calls it, and it must keep writing the quota row until the new worker
-- (which calls these two instead) is deployed with `wrangler deploy`.
--
-- Revert: DROP FUNCTION public.mcp_reserve_tool_call(text, text);
--         DROP FUNCTION public.mcp_log_tool_detail(text, text, jsonb);

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

-- anon-exec: revoked (mcp_reserve_tool_call) — service_role only; the MCP worker calls it with the service key.
-- anon-exec: revoked (mcp_log_tool_detail) — service_role only; the MCP worker calls it with the service key.
REVOKE EXECUTE ON FUNCTION public.mcp_reserve_tool_call(text, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.mcp_log_tool_detail(text, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mcp_reserve_tool_call(text, text) TO postgres, service_role;
GRANT EXECUTE ON FUNCTION public.mcp_log_tool_detail(text, text, jsonb) TO postgres, service_role;

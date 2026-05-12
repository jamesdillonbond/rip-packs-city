-- ================================================================
-- mcp_phase1_api_keys_and_quotas
--
-- Applied to live database via Supabase MCP on 2026-05-12 as
-- version 20260512155009. Committed to repo retroactively to
-- close the live-DB / migrations-directory drift.
--
-- Phase 1 of Flow Agents integration: stand up the read-only
-- data plane. Backs the `rpc-mcp-proxy` Cloudflare Worker that
-- exposes RPC's intelligence (FMV, sniper, pack EV, sets, badges,
-- wallet) as a Flow MCP server.
--
-- Identity model: wallet_address-keyed, matching pro_users and
-- usage_events. Wallet-first per RPC convention.
--
-- Agent execution surface (writes, on-chain txs, Cadence policy
-- contract) is intentionally deferred to Phase 2+. Schemas without
-- callers are noise.
-- ================================================================

-- 1. API key table
create table if not exists public.mcp_api_keys (
  key_id uuid primary key default gen_random_uuid(),
  key_hash text not null unique,
  key_prefix text not null,
  wallet_address text not null,
  label text,
  plan text not null default 'free' check (plan in ('free','pro','founding','partner')),
  status text not null default 'active' check (status in ('active','revoked','expired')),
  scopes text[] not null default array['read']::text[],
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  expires_at timestamptz
);

create index if not exists idx_mcp_api_keys_wallet
  on public.mcp_api_keys(wallet_address) where status = 'active';
create index if not exists idx_mcp_api_keys_lookup
  on public.mcp_api_keys(key_hash) where status = 'active';

comment on table public.mcp_api_keys is
  'API keys for the rpc-mcp-proxy Cloudflare Worker (Flow MCP server surface). Wallet-address-keyed to mirror pro_users. key_hash = sha256(raw_key) hex; raw value is shown to the user exactly once at issuance and never persisted. RLS service_role-only.';

alter table public.mcp_api_keys enable row level security;
-- No anon/authenticated policies — deny by default per design system convention.

-- 2. Validation RPC — worker calls on every request
create or replace function public.mcp_validate_api_key(p_key_hash text)
returns table (
  key_id uuid,
  wallet_address text,
  plan text,
  scopes text[]
)
language plpgsql
security definer
set search_path = public
as $fn$
begin
  return query
  select k.key_id, k.wallet_address, k.plan, k.scopes
    from public.mcp_api_keys k
   where k.key_hash = p_key_hash
     and k.status = 'active'
     and (k.expires_at is null or k.expires_at > now());

  if found then
    update public.mcp_api_keys
       set last_used_at = now()
     where key_hash = p_key_hash;
  end if;
end;
$fn$;

revoke all on function public.mcp_validate_api_key(text) from public;
grant execute on function public.mcp_validate_api_key(text) to service_role;
comment on function public.mcp_validate_api_key(text) is
  'Worker calls with sha256-hex of bearer token. Returns one row if valid+active+unexpired; updates last_used_at. service_role only.';

-- 3. Issuance RPC — returns raw_key exactly once
create or replace function public.mcp_issue_api_key(
  p_wallet_address text,
  p_label text default null,
  p_scopes text[] default array['read']::text[]
)
returns table (key_id uuid, raw_key text, key_prefix text)
language plpgsql
security definer
set search_path = public, extensions
as $fn$
declare
  v_random bytea;
  v_raw text;
  v_hash text;
  v_prefix text;
  v_plan text;
begin
  p_wallet_address := lower(trim(p_wallet_address));
  if p_wallet_address is null or p_wallet_address = '' then
    raise exception 'wallet_address required';
  end if;

  -- Plan resolved from pro_users; defaults to free.
  select coalesce(p.plan, 'free') into v_plan
    from public.pro_users p
   where p.wallet_address = p_wallet_address
     and (p.expires_at is null or p.expires_at > now())
   limit 1;
  if v_plan is null then v_plan := 'free'; end if;

  v_random := extensions.gen_random_bytes(32);
  v_raw := 'rpc_mcp_live_' || translate(encode(v_random, 'base64'), '+/=', '');
  v_hash := encode(extensions.digest(v_raw, 'sha256'), 'hex');
  v_prefix := substring(v_raw from 1 for 20);

  insert into public.mcp_api_keys (key_hash, key_prefix, wallet_address, label, plan, scopes)
    values (v_hash, v_prefix, p_wallet_address, p_label, v_plan, p_scopes)
    returning mcp_api_keys.key_id into key_id;

  raw_key := v_raw;
  key_prefix := v_prefix;
  return next;
end;
$fn$;

revoke all on function public.mcp_issue_api_key(text, text, text[]) from public;
grant execute on function public.mcp_issue_api_key(text, text, text[]) to service_role;
comment on function public.mcp_issue_api_key(text, text, text[]) is
  'Issues a new MCP API key. Returns raw_key ONCE — caller must surface to user immediately as it is never recoverable. service_role only.';

-- 4. Revoke RPC
create or replace function public.mcp_revoke_api_key(p_key_id uuid, p_wallet_address text)
returns boolean
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_rows int;
begin
  update public.mcp_api_keys
     set status = 'revoked', revoked_at = now()
   where key_id = p_key_id
     and wallet_address = lower(trim(p_wallet_address))
     and status = 'active';
  get diagnostics v_rows = row_count;
  return v_rows > 0;
end;
$fn$;

revoke all on function public.mcp_revoke_api_key(uuid, text) from public;
grant execute on function public.mcp_revoke_api_key(uuid, text) to service_role;

-- 5. List keys for a wallet (no hashes, no raws)
create or replace function public.mcp_list_keys(p_wallet_address text)
returns table (
  key_id uuid,
  key_prefix text,
  label text,
  plan text,
  status text,
  scopes text[],
  created_at timestamptz,
  last_used_at timestamptz,
  expires_at timestamptz
)
language sql
security definer
set search_path = public
as $fn$
  select k.key_id, k.key_prefix, k.label, k.plan, k.status, k.scopes,
         k.created_at, k.last_used_at, k.expires_at
    from public.mcp_api_keys k
   where k.wallet_address = lower(trim(p_wallet_address))
   order by k.created_at desc;
$fn$;

revoke all on function public.mcp_list_keys(text) from public;
grant execute on function public.mcp_list_keys(text) to service_role;

-- 6. Usage logging via existing usage_events (no new infra)
create or replace function public.mcp_log_tool_call(
  p_wallet_address text,
  p_tool_name text,
  p_metadata jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
begin
  insert into public.usage_events(wallet_address, feature_name, metadata)
    values (
      lower(trim(p_wallet_address)),
      'mcp_' || p_tool_name,
      coalesce(p_metadata, '{}'::jsonb)
    );
end;
$fn$;

revoke all on function public.mcp_log_tool_call(text, text, jsonb) from public;
grant execute on function public.mcp_log_tool_call(text, text, jsonb) to service_role;

-- 7. Feature quotas for MCP plans
insert into public.feature_quotas (plan, feature_name, daily_limit, notes)
values
  ('free',     'mcp_query', 100,  'Free-tier MCP daily tool-call cap. Read-only.'),
  ('pro',      'mcp_query', 5000, 'Pro-tier MCP daily tool-call cap.'),
  ('founding', 'mcp_query', null, 'Founding members: unlimited MCP.'),
  ('partner',  'mcp_query', null, 'Partner/B2B integration tier: unlimited, tracked.')
on conflict (feature_name, plan) do update
  set daily_limit = excluded.daily_limit,
      notes = excluded.notes,
      updated_at = now();

-- 8. Observability view
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
   and occurred_at >= now() - interval '24 hours'
 group by 1, 2, 3;

comment on view public.v_mcp_usage_today is
  'Hourly MCP tool-call usage in the last 24h. Drives the rpc-mcp-proxy observability surface.';

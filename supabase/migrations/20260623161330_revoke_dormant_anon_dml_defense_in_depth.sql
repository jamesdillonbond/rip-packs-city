-- Defense-in-depth: REVOKE anon INSERT/UPDATE/DELETE on base tables where anon
-- holds the (Supabase-default) grant but NO permissive anon/public write policy
-- exists -> RLS already blocks the write, so this is a zero-behavior-change
-- hardening (removes the dormant capability, protects against a future RLS
-- misconfig). Tables WITH a real anon write policy (email_subscribers,
-- outbound_clicks, portfolio_snapshots, support_conversations, + 19 others) are
-- excluded by construction and keep their grants. anon SELECT is untouched.
-- Revert: GRANT INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO anon;
--
-- Applied live 2026-06-23 via Supabase MCP; this file is the repo-parity copy.
do $$
declare r record; n int := 0;
begin
  for r in
    with anon_dml as (
      select g.table_name, g.privilege_type
      from information_schema.role_table_grants g
      join pg_class c on c.relname = g.table_name
      join pg_namespace nn on nn.oid = c.relnamespace and nn.nspname = 'public'
      where g.table_schema = 'public' and g.grantee = 'anon'
        and g.privilege_type in ('INSERT','UPDATE','DELETE') and c.relkind in ('r','p')
    ),
    write_policies as (
      select tablename, cmd from pg_policies
      where schemaname = 'public'
        and (roles && array['anon','public']::name[])
        and cmd in ('INSERT','UPDATE','DELETE','ALL')
    )
    select a.table_name, a.privilege_type
    from anon_dml a
    where not exists (
      select 1 from write_policies w
      where w.tablename = a.table_name and (w.cmd = 'ALL' or w.cmd = a.privilege_type)
    )
  loop
    execute format('revoke %s on public.%I from anon', r.privilege_type, r.table_name);
    n := n + 1;
  end loop;
  raise notice 'revoked % dormant anon DML grants', n;
end $$;

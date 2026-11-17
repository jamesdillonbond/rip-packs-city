-- Durable anon-grant default: stop new postgres-created public tables from being
-- born anon-writable. Root cause (confirmed via pg_default_acl): the public-schema
-- default ACL granted anon full DML (arwdDxtm) on every table postgres creates,
-- which is why each new table this week needed a manual "REVOKE anon ...".
-- This REVOKEs the DML defaults from the postgres role only; future anon-writable
-- tables must now GRANT anon explicitly + carry an RLS policy (correct opt-in).
--
-- anon keeps SELECT/REFERENCES/MAINTAIN by default (default ACL becomes anon=rxm),
-- so the PostgREST read API is intact. authenticated/service_role/postgres are
-- untouched. NOT retroactive — existing tables/grants are unchanged; RLS still
-- gates everything.
--
-- Revert: ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
--         GRANT INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER ON TABLES TO anon;
--
-- Applied live 2026-06-24 via Supabase MCP; this file is the repo-parity copy.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER ON TABLES FROM anon;

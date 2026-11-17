-- audit_20260727_move_pgstattuple_to_extensions_schema
-- Security advisor `extension_in_public`: pgstattuple was installed in `public`.
-- Move it to the dedicated `extensions` schema (Supabase's standard home). Its six
-- diagnostic functions (pgstattuple, pgstatindex, pg_relpages, pgstatginindex,
-- pgstathashindex, pgstattuple_approx) have ZERO references anywhere -- no repo
-- code, no DB function/view body -- so nothing relies on them resolving via the
-- public search_path. Applied live via Supabase MCP on 2026-07-27;
-- check_public_security_invariants()/check_anon_write_surface() still [].
-- Revert: ALTER EXTENSION pgstattuple SET SCHEMA public;
ALTER EXTENSION pgstattuple SET SCHEMA extensions;

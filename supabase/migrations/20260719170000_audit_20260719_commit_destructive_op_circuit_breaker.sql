-- audit_20260719_commit_destructive_op_circuit_breaker
--
-- CAPTURES the LIVE destructive-op circuit breaker into version control. This
-- guard has protected prod since 2026-06-27 but was applied via MCP and never
-- committed as a migration — so it was un-versioned and un-testable. This file
-- reproduces the CURRENT prod definition EXACTLY (function body captured verbatim
-- via pg_get_functiondef; triggers via pg_get_triggerdef; config rows read live).
--
-- It is FULLY IDEMPOTENT and captures existing state — it does NOT change prod
-- behavior: CREATE OR REPLACE FUNCTION with the identical body is a no-op,
-- CREATE OR REPLACE TRIGGER with identical defs is a no-op, CREATE TABLE IF NOT
-- EXISTS skips the existing table, and the config seed is ON CONFLICT DO NOTHING.
-- Its purpose is versioning + enabling the db-invariant test
-- (supabase/tests/rpc_guard_block_destructive.sql), which pins the guard's
-- behavior in CI. No prod migration process applies repo files automatically.

-- ── config table (per-table thresholds) ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.rpc_delete_guard_config (
  table_name text PRIMARY KEY,
  max_rows integer,
  max_wallet_span integer,
  block_truncate boolean NOT NULL DEFAULT true,
  enabled boolean NOT NULL DEFAULT true,
  note text
);
ALTER TABLE public.rpc_delete_guard_config ENABLE ROW LEVEL SECURITY;

INSERT INTO public.rpc_delete_guard_config (table_name, max_rows, max_wallet_span, block_truncate, enabled, note) VALUES
  ('editions', 25, NULL, true, true, 'canonical catalog; UUID dupes are NULLed not deleted, so ~0 routine deletes'),
  ('pinnacle_editions', 25, NULL, true, true, 'Pinnacle catalog; ~0 routine deletes'),
  ('wallet_moments_cache', NULL, 3, true, true, 'legit deletes are single-wallet (upsert_wallet_moments / weekly maint); blind delete spanned many wallets')
ON CONFLICT (table_name) DO NOTHING;

-- ── guard function (verbatim prod definition) ────────────────────────────────
CREATE OR REPLACE FUNCTION public.rpc_guard_block_destructive()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  cfg public.rpc_delete_guard_config%ROWTYPE;
  n_rows bigint;
  n_wallets bigint;
  allowed text := coalesce(current_setting('rpc.allow_bulk_delete', true), 'off');
BEGIN
  IF allowed = 'on' THEN RETURN NULL; END IF;           -- explicit intentional opt-in bypasses
  SELECT * INTO cfg FROM public.rpc_delete_guard_config WHERE table_name = TG_TABLE_NAME;
  IF cfg.table_name IS NULL OR NOT cfg.enabled THEN RETURN NULL; END IF;

  IF TG_OP = 'TRUNCATE' THEN
    IF cfg.block_truncate THEN
      RAISE EXCEPTION 'rpc_delete_guard: TRUNCATE on % is blocked (irreplaceable table). Set "SET LOCAL rpc.allow_bulk_delete=on" in your txn if this is intentional.', TG_TABLE_NAME;
    END IF;
    RETURN NULL;
  END IF;

  IF cfg.max_wallet_span IS NOT NULL AND TG_TABLE_NAME = 'wallet_moments_cache' THEN
    SELECT count(*), count(DISTINCT wallet_address) INTO n_rows, n_wallets FROM oldtab;
    IF n_wallets > cfg.max_wallet_span THEN
      RAISE EXCEPTION 'rpc_delete_guard: DELETE on % spans % distinct wallets (limit %); blocked (% rows). Legit refreshes are single-wallet. Set "SET LOCAL rpc.allow_bulk_delete=on" if intentional.', TG_TABLE_NAME, n_wallets, cfg.max_wallet_span, n_rows;
    END IF;
  ELSIF cfg.max_rows IS NOT NULL THEN
    SELECT count(*) INTO n_rows FROM oldtab;
    IF n_rows > cfg.max_rows THEN
      RAISE EXCEPTION 'rpc_delete_guard: DELETE on % affects % rows (limit %); blocked. Set "SET LOCAL rpc.allow_bulk_delete=on" if intentional.', TG_TABLE_NAME, n_rows, cfg.max_rows;
    END IF;
  END IF;
  RETURN NULL;
END $function$;

-- ── triggers (verbatim prod definitions) ─────────────────────────────────────
CREATE OR REPLACE TRIGGER zzz_guard_del_editions AFTER DELETE ON public.editions REFERENCING OLD TABLE AS oldtab FOR EACH STATEMENT EXECUTE FUNCTION rpc_guard_block_destructive();
CREATE OR REPLACE TRIGGER zzz_guard_trunc_editions BEFORE TRUNCATE ON public.editions FOR EACH STATEMENT EXECUTE FUNCTION rpc_guard_block_destructive();
CREATE OR REPLACE TRIGGER zzz_guard_del_pinnacle AFTER DELETE ON public.pinnacle_editions REFERENCING OLD TABLE AS oldtab FOR EACH STATEMENT EXECUTE FUNCTION rpc_guard_block_destructive();
CREATE OR REPLACE TRIGGER zzz_guard_trunc_pinnacle BEFORE TRUNCATE ON public.pinnacle_editions FOR EACH STATEMENT EXECUTE FUNCTION rpc_guard_block_destructive();
CREATE OR REPLACE TRIGGER zzz_guard_del_wmc AFTER DELETE ON public.wallet_moments_cache REFERENCING OLD TABLE AS oldtab FOR EACH STATEMENT EXECUTE FUNCTION rpc_guard_block_destructive();
CREATE OR REPLACE TRIGGER zzz_guard_trunc_wmc BEFORE TRUNCATE ON public.wallet_moments_cache FOR EACH STATEMENT EXECUTE FUNCTION rpc_guard_block_destructive();

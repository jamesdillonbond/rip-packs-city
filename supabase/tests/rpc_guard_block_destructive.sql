-- DB invariant: public.rpc_guard_block_destructive — the destructive-op circuit
-- breaker. A statement-level trigger on the three irreplaceable catalog/cache
-- tables that BLOCKS bulk/cross-cutting deletes (and TRUNCATE) unless the caller
-- explicitly opts in with `SET LOCAL rpc.allow_bulk_delete=on`. This exists
-- because a session once blind-deleted 1,724 wallet_moments_cache rows. Thresholds
-- live in rpc_delete_guard_config (editions/pinnacle: >25 rows; wmc: DELETE
-- spanning >3 distinct wallets; TRUNCATE on any: blocked).
--
-- The function + trigger DDL below is VERBATIM from the committed migration
-- (supabase/migrations/20260719170000_audit_20260719_commit_destructive_op_circuit_breaker.sql),
-- which is itself byte-identical to the live prod definition (verified by md5 of
-- pg_get_functiondef). __tests__/db-invariants-drift-guard.test.ts fails CI if the
-- function copy drifts.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE public.rpc_delete_guard_config (
  table_name text PRIMARY KEY, max_rows integer, max_wallet_span integer,
  block_truncate boolean NOT NULL DEFAULT true, enabled boolean NOT NULL DEFAULT true, note text);
CREATE TABLE public.wallet_moments_cache (wallet_address text, moment_id text);
CREATE TABLE public.editions (id int);
CREATE TABLE public.pinnacle_editions (id int);

INSERT INTO public.rpc_delete_guard_config (table_name, max_rows, max_wallet_span) VALUES
  ('editions', 25, NULL), ('pinnacle_editions', 25, NULL), ('wallet_moments_cache', NULL, 3);

-- >>> BEGIN verbatim rpc_guard_block_destructive + triggers (byte-identical to the migration/prod) >>>
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
-- <<< END verbatim rpc_guard_block_destructive <<<

-- Seed: editions 30 rows; wmc 5 rows across 5 distinct wallets.
INSERT INTO public.editions SELECT generate_series(1, 30);
INSERT INTO public.wallet_moments_cache VALUES ('W1','m1'),('W2','m2'),('W3','m3'),('W4','m4'),('W5','m5');

-- ── editions: >25-row delete blocked; <=25 allowed ──────────────────────────
DO $t$ BEGIN
  DELETE FROM public.editions;                 -- 30 > 25
  RAISE EXCEPTION 'NOT_BLOCKED';
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM NOT LIKE '%rpc_delete_guard%' THEN RAISE; END IF;
END $t$;
SELECT _assert_eq((SELECT count(*)::text FROM public.editions), '30', 'editions bulk delete (>25) blocked — nothing removed');

DELETE FROM public.editions WHERE id <= 10;    -- 10 <= 25
SELECT _assert_eq((SELECT count(*)::text FROM public.editions), '20', 'editions scoped delete (<=25) allowed');

-- ── wmc: cross-wallet delete blocked; single-wallet allowed ─────────────────
DO $t$ BEGIN
  DELETE FROM public.wallet_moments_cache;      -- spans 5 wallets > 3
  RAISE EXCEPTION 'NOT_BLOCKED';
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM NOT LIKE '%distinct wallets%' THEN RAISE; END IF;
END $t$;
SELECT _assert_eq((SELECT count(*)::text FROM public.wallet_moments_cache), '5', 'wmc cross-wallet bulk delete blocked');

DELETE FROM public.wallet_moments_cache WHERE wallet_address = 'W1';  -- 1 wallet <= 3
SELECT _assert_eq((SELECT count(*)::text FROM public.wallet_moments_cache), '4', 'wmc single-wallet delete allowed');

-- ── TRUNCATE on a guarded table blocked ─────────────────────────────────────
DO $t$ BEGIN
  TRUNCATE public.wallet_moments_cache;
  RAISE EXCEPTION 'NOT_BLOCKED';
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM NOT LIKE '%TRUNCATE%blocked%' THEN RAISE; END IF;
END $t$;
SELECT _assert_eq((SELECT count(*)::text FROM public.wallet_moments_cache), '4', 'TRUNCATE blocked — rows intact');

-- ── explicit opt-in bypasses the guard (LAST: SET LOCAL persists in the txn) ─
SET LOCAL rpc.allow_bulk_delete = 'on';
DELETE FROM public.wallet_moments_cache;         -- 4 wallets > 3, but opted in
SELECT _assert_eq((SELECT count(*)::text FROM public.wallet_moments_cache), '0', 'SET LOCAL rpc.allow_bulk_delete=on bypasses the guard');

SELECT '✓ rpc_guard_block_destructive invariants pass' AS result;
ROLLBACK;

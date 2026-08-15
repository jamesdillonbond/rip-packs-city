-- DB invariant: public.prune_stale_wmc — the WEEKLY DELETE (pg_cron
-- `20 10 * * 0`) against wallet_moments_cache, the ~2.2M-row portfolio store
-- that ~34 DB functions sum for a collector's FMV total.
--
-- Every failure mode here is silent data loss, not an error:
--   1. the 14-day bound appears TWICE, and the copy INSIDE the per-wallet DELETE
--      is the load-bearing one — without it, a wallet that qualifies on any one
--      stale row loses its ENTIRE cache, including moments seen minutes ago;
--   2. an ACTIVE seeded wallet is never pruned, however stale — these back the
--      public leaderboards and analytics;
--   3. an INACTIVE seeded wallet is NOT exempt, so the exemption cannot be
--      widened to "is it in seeded_wallets" without changing behaviour.
--
-- The per-wallet LOOP is also a correctness requirement rather than a style
-- choice: a single set-based DELETE spanning >3 distinct wallets is blocked at
-- runtime by rpc_guard_block_destructive on this table.
--
-- The function DDL below is VERBATIM from the committed migration
-- (supabase/migrations/20260815203700_audit_20260815_snapshot_prune_stale_wmc.sql),
-- whose body was verified byte-identical to live prod via prosrc md5 on
-- 2026-08-15. __tests__/db-invariants-drift-guard.test.ts fails CI on drift.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE public.wallet_moments_cache (
  id             bigserial primary key,
  wallet_address text,
  moment_id      text,
  last_seen_at   timestamptz
);

CREATE TABLE public.seeded_wallets (
  wallet_address text,
  is_active      boolean
);

-- The real function calls log_pipeline_run(); stub it so the test stays
-- self-contained on a vanilla Postgres. Named arguments must match the live
-- 11-arg signature for the call to resolve — a wrong argument NAME is exactly
-- the failure that made /api/cron/stale-fmv-monitor write zero rows forever.
CREATE TABLE public._pipeline_runs_log (pipeline text, rows_written int, extra jsonb);
CREATE OR REPLACE FUNCTION public.log_pipeline_run(
  p_pipeline text,
  p_started_at timestamptz DEFAULT NULL,
  p_rows_found int DEFAULT NULL,
  p_rows_written int DEFAULT NULL,
  p_rows_skipped int DEFAULT NULL,
  p_ok boolean DEFAULT true,
  p_error text DEFAULT NULL,
  p_collection_slug text DEFAULT NULL,
  p_cursor_before text DEFAULT NULL,
  p_cursor_after text DEFAULT NULL,
  p_extra jsonb DEFAULT NULL
) RETURNS void LANGUAGE plpgsql AS $stub$
BEGIN
  INSERT INTO public._pipeline_runs_log VALUES (p_pipeline, p_rows_written, p_extra);
END $stub$;

-- >>> BEGIN verbatim prune_stale_wmc (byte-identical to the migration/prod) >>>
CREATE OR REPLACE FUNCTION public.prune_stale_wmc()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '600s'
AS $function$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_stale_cache_deleted integer := 0;
  v_wallets_pruned integer := 0;
  v_wallet text;
  v_chunk integer;
BEGIN
  -- Belt-and-suspenders: robust even if invoked by a role with a tighter default
  -- (service_role 30s); cron_heavy already defaults to 600s.
  PERFORM set_config('statement_timeout', '600000', true);

  FOR v_wallet IN
    SELECT DISTINCT w.wallet_address
    FROM public.wallet_moments_cache w
    WHERE w.last_seen_at < now() - interval '14 days'
      AND NOT EXISTS (
        SELECT 1 FROM seeded_wallets sw
        WHERE sw.wallet_address = w.wallet_address
          AND sw.is_active = true
      )
  LOOP
    DELETE FROM public.wallet_moments_cache
    WHERE wallet_address = v_wallet
      AND last_seen_at < now() - interval '14 days';
    GET DIAGNOSTICS v_chunk = ROW_COUNT;
    v_stale_cache_deleted := v_stale_cache_deleted + v_chunk;
    IF v_chunk > 0 THEN
      v_wallets_pruned := v_wallets_pruned + 1;
    END IF;
  END LOOP;

  PERFORM public.log_pipeline_run(
    p_pipeline := 'weekly-wmc-prune',
    p_started_at := v_started,
    p_rows_written := v_stale_cache_deleted,
    p_extra := jsonb_build_object(
      'stale_cache_deleted', v_stale_cache_deleted,
      'wallets_pruned',      v_wallets_pruned
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'stale_cache_deleted', v_stale_cache_deleted,
    'wallets_pruned',      v_wallets_pruned,
    'duration_ms', EXTRACT(milliseconds FROM (clock_timestamp() - v_started))::integer
  );
END;
$function$;
-- <<< END verbatim prune_stale_wmc <<<

INSERT INTO public.seeded_wallets (wallet_address, is_active) VALUES
  ('0xSEEDED_ACTIVE',   true),
  ('0xSEEDED_INACTIVE', false);

INSERT INTO public.wallet_moments_cache (wallet_address, moment_id, last_seen_at) VALUES
  -- ⚠ THE CASE THE INNER 14-DAY BOUND EXISTS FOR: one stale row makes this
  -- wallet a candidate, but its two FRESH rows must survive the delete.
  ('0xMIXED',           'm1', now() - interval '30 days'),
  ('0xMIXED',           'm2', now() - interval '1 day'),
  ('0xMIXED',           'm3', now()),
  -- Entirely stale, not seeded → fully pruned.
  ('0xCOLD',            'm4', now() - interval '90 days'),
  ('0xCOLD',            'm5', now() - interval '20 days'),
  -- Entirely fresh → never a candidate.
  ('0xWARM',            'm6', now() - interval '2 days'),
  -- Stale but ACTIVE seeded → exempt.
  ('0xSEEDED_ACTIVE',   'm7', now() - interval '200 days'),
  -- Stale and INACTIVE seeded → NOT exempt.
  ('0xSEEDED_INACTIVE', 'm8', now() - interval '200 days');

SELECT _assert_eq((public.prune_stale_wmc() ->> 'stale_cache_deleted'), '4',
  'deletes only the stale rows: 1 from MIXED, 2 from COLD, 1 from the INACTIVE seed');
SELECT _assert_eq((SELECT count(*)::text FROM public.wallet_moments_cache), '4',
  'four rows survive');

-- ── The inner bound: a candidate wallet keeps its FRESH rows ───────────────
-- Removing the second `last_seen_at < …` predicate would delete all three MIXED
-- rows and still return a plausible number — this is the assertion that catches
-- it, and the only one that distinguishes the two implementations.
SELECT _assert_eq(
  (SELECT count(*)::text FROM public.wallet_moments_cache WHERE wallet_address='0xMIXED'),
  '2',
  'a wallet pruned for ONE stale row keeps every row inside the 14-day window');
SELECT _assert(
  NOT EXISTS (SELECT 1 FROM public.wallet_moments_cache
               WHERE wallet_address='0xMIXED' AND moment_id='m1'),
  'the stale row itself is gone');

-- ── The seeded exemption, in BOTH directions ───────────────────────────────
SELECT _assert(
  EXISTS (SELECT 1 FROM public.wallet_moments_cache WHERE wallet_address='0xSEEDED_ACTIVE'),
  'an ACTIVE seeded wallet is never pruned, however stale');
SELECT _assert(
  NOT EXISTS (SELECT 1 FROM public.wallet_moments_cache WHERE wallet_address='0xSEEDED_INACTIVE'),
  'an INACTIVE seeded wallet is NOT exempt — the exemption is is_active, not membership');

-- ── Untouched wallets ──────────────────────────────────────────────────────
SELECT _assert_eq(
  (SELECT count(*)::text FROM public.wallet_moments_cache WHERE wallet_address='0xWARM'), '1',
  'a wholly-fresh wallet is never a candidate');
SELECT _assert(
  NOT EXISTS (SELECT 1 FROM public.wallet_moments_cache WHERE wallet_address='0xCOLD'),
  'a wholly-stale unseeded wallet is fully pruned');

-- ── wallets_pruned counts WALLETS, not rows ────────────────────────────────
-- It is the operator-facing number in the pipeline_runs row, so conflating the
-- two would misreport blast radius on the one sweep that has real blast radius.
SELECT _assert_eq(
  (SELECT extra ->> 'wallets_pruned' FROM public._pipeline_runs_log), '3',
  'three distinct wallets contributed deletions (MIXED, COLD, INACTIVE seed)');
SELECT _assert_eq(
  (SELECT rows_written::text FROM public._pipeline_runs_log), '4',
  'the logged rows_written is the ROW count, not the wallet count');
SELECT _assert_eq(
  (SELECT pipeline FROM public._pipeline_runs_log), 'weekly-wmc-prune',
  'the sweep logs under its own pipeline name so a silent week is detectable');

-- ── Idempotent ─────────────────────────────────────────────────────────────
SELECT _assert_eq((public.prune_stale_wmc() ->> 'stale_cache_deleted'), '0',
  're-running immediately deletes nothing');
SELECT _assert_eq((public.prune_stale_wmc() ->> 'wallets_pruned'), '0',
  'and reports zero wallets pruned rather than re-counting candidates');

SELECT '✓ prune_stale_wmc invariants pass' AS result;
ROLLBACK;

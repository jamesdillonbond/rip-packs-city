-- DB invariant: public.purge_candy_wmc_ghost_rows — the daily self-heal (pg_cron
-- `10 9 * * *`, jobid 201) for the Candy DAS group-walk, which never deletes the
-- PRIOR owner's row when a mint transfers.
--
-- This function holds a deliberate opt-in past the destructive-op circuit
-- breaker (`set_config('rpc.allow_bulk_delete','on', true)`), so the platform's
-- backstop against a bulk wallet_moments_cache DELETE does not apply to it. A
-- pin is therefore the only remaining check on what it deletes — and wmc is the
-- portfolio store that ~34 DB functions sum for a collector's FMV total, so a
-- wrong delete here shows someone else's Moments with no error anywhere.
--
-- Two invariants, both silent on failure:
--   1. the SURVIVOR is the newest row per moment_id (ORDER BY last_seen_at DESC,
--      rn > 1) — inverting it keeps the ghost and deletes the live owner;
--   2. it is SCOPED to the Candy collection uuid — wmc holds all six
--      collections, and moment_id is not unique across them.
--
-- The function DDL below is VERBATIM from the committed migration
-- (supabase/migrations/20260815203600_audit_20260815_snapshot_purge_candy_wmc_ghost_rows.sql),
-- whose body was verified byte-identical to live prod via prosrc md5 on
-- 2026-08-15. __tests__/db-invariants-drift-guard.test.ts fails CI on drift.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE public.wallet_moments_cache (
  id             uuid primary key default gen_random_uuid(),
  wallet_address text,
  collection_id  uuid,
  moment_id      text,
  last_seen_at   timestamptz
);

-- >>> BEGIN verbatim purge_candy_wmc_ghost_rows (byte-identical to the migration/prod) >>>
CREATE OR REPLACE FUNCTION public.purge_candy_wmc_ghost_rows()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '120s'
AS $function$
DECLARE
  v_deleted integer := 0;
BEGIN
  -- Deliberate, scoped opt-in past rpc_guard_block_destructive: this function only ever
  -- deletes rows that are provably superseded by a newer row for the SAME moment_id.
  PERFORM set_config('rpc.allow_bulk_delete', 'on', true);

  WITH ranked AS (
    SELECT id, row_number() OVER (PARTITION BY moment_id ORDER BY last_seen_at DESC) AS rn
    FROM public.wallet_moments_cache
    WHERE collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'
  ), del AS (
    DELETE FROM public.wallet_moments_cache w
    USING ranked r
    WHERE w.id = r.id AND r.rn > 1
    RETURNING 1
  )
  SELECT count(*) INTO v_deleted FROM del;

  RETURN v_deleted;
END;
$function$;
-- <<< END verbatim purge_candy_wmc_ghost_rows <<<

-- Candy = 209ade70-…; Top Shot = 95f28a17-… (the cross-collection control).
INSERT INTO public.wallet_moments_cache (wallet_address, collection_id, moment_id, last_seen_at) VALUES
  -- A transferred mint: the OLD owner's row is the ghost, the NEW owner's is live.
  ('0xOLD',   '209ade70-32c5-4470-bc7c-4793d660f713', 'mint-1', now() - interval '3 days'),
  ('0xNEW',   '209ade70-32c5-4470-bc7c-4793d660f713', 'mint-1', now()),
  -- Transferred twice: two ghosts, one survivor.
  ('0xA',     '209ade70-32c5-4470-bc7c-4793d660f713', 'mint-2', now() - interval '9 days'),
  ('0xB',     '209ade70-32c5-4470-bc7c-4793d660f713', 'mint-2', now() - interval '2 days'),
  ('0xC',     '209ade70-32c5-4470-bc7c-4793d660f713', 'mint-2', now()),
  -- Never transferred: a single row must never be touched.
  ('0xSOLO',  '209ade70-32c5-4470-bc7c-4793d660f713', 'mint-3', now() - interval '40 days'),
  -- SAME moment_id, DIFFERENT collection — the scoping control.
  ('0xTS1',   '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'mint-1', now() - interval '5 days'),
  ('0xTS2',   '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'mint-1', now());

SELECT _assert_eq(public.purge_candy_wmc_ghost_rows()::text, '3',
  'exactly the three superseded Candy rows are deleted (1 for mint-1, 2 for mint-2)');

-- ── The SURVIVOR must be the NEWEST row, i.e. the current owner ─────────────
-- This is the assertion that inverting the ORDER BY breaks, and the one whose
-- failure is invisible: the row count is identical either way.
SELECT _assert_eq(
  (SELECT wallet_address FROM public.wallet_moments_cache
    WHERE moment_id='mint-1' AND collection_id='209ade70-32c5-4470-bc7c-4793d660f713'),
  '0xNEW',
  'the surviving Candy row for a transferred mint is the CURRENT owner, not the ghost');
SELECT _assert_eq(
  (SELECT wallet_address FROM public.wallet_moments_cache
    WHERE moment_id='mint-2' AND collection_id='209ade70-32c5-4470-bc7c-4793d660f713'),
  '0xC',
  'with two ghosts, the newest of three survives');

-- ── A moment with a single row is never touched, however stale ─────────────
SELECT _assert(
  EXISTS (SELECT 1 FROM public.wallet_moments_cache WHERE wallet_address='0xSOLO'),
  'a 40-day-old row with no duplicate is NOT a ghost — this function prunes by
   supersession, never by age');

-- ── The collection scope is load-bearing ───────────────────────────────────
-- Both Top Shot rows share moment_id "mint-1" with the Candy pair above. An
-- unscoped version would dedupe across collections and delete one of them.
SELECT _assert_eq(
  (SELECT count(*)::text FROM public.wallet_moments_cache
    WHERE collection_id='95f28a17-224a-4025-96ad-adf8a4c63bfd'), '2',
  'rows in another collection sharing a moment_id are untouched');

-- ── Idempotent: a second sweep finds nothing ───────────────────────────────
SELECT _assert_eq(public.purge_candy_wmc_ghost_rows()::text, '0',
  're-running immediately deletes nothing');
SELECT _assert_eq((SELECT count(*)::text FROM public.wallet_moments_cache), '5',
  'the post-sweep row set is stable');

-- ── An empty Candy cache is a no-op, not an error ──────────────────────────
DELETE FROM public.wallet_moments_cache
 WHERE collection_id='209ade70-32c5-4470-bc7c-4793d660f713';
SELECT _assert_eq(public.purge_candy_wmc_ghost_rows()::text, '0',
  'no Candy rows at all returns 0 rather than raising');

SELECT '✓ purge_candy_wmc_ghost_rows invariants pass' AS result;
ROLLBACK;

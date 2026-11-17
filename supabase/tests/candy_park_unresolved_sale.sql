-- DB invariant: public.candy_park_unresolved_sale — the parking lot for Candy
-- (Solana) sales the indexer could not resolve to an edition yet. It upserts a
-- row into candy_sales_unresolved keyed by (signature, token_mint); a re-park of
-- a still-unresolved sale bumps `attempts` and refreshes `skip_reason`. The
-- load-bearing subtlety is the `WHERE resolved_at IS NULL` guard on the ON
-- CONFLICT DO UPDATE: once a parked sale has been RESOLVED, re-parking it must be
-- a NO-OP — otherwise a late duplicate event would resurrect a resolved row's
-- retry counters and it would be re-processed forever. It also always stamps the
-- fixed Candy MLB collection UUID.
--
-- The function DDL below is VERBATIM from the committed migration
-- (supabase/migrations/20260726233100_audit_20260726_candy_park_unresolved_sale_fn.sql),
-- and was verified byte-identical to the live prod definition via
-- pg_get_functiondef on 2026-07-31. __tests__/db-invariants-drift-guard.test.ts
-- fails CI if the copy drifts from the migration.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

-- Minimal fixture (columns + defaults + the (signature, token_mint) uniqueness
-- the ON CONFLICT targets, matching the live table).
CREATE TABLE public.candy_sales_unresolved (
  signature       text,
  token_mint      text,
  collection_id   uuid,
  block_time      timestamptz,
  price_sol       numeric,
  buyer           text,
  seller          text,
  skip_reason     text,
  attempts        integer NOT NULL DEFAULT 1,
  first_seen_at   timestamptz NOT NULL DEFAULT now(),
  last_attempt_at timestamptz NOT NULL DEFAULT now(),
  resolved_at     timestamptz,
  resolution      text,
  UNIQUE (signature, token_mint)
);

-- >>> BEGIN verbatim candy_park_unresolved_sale (byte-identical to the migration/prod) >>>
CREATE OR REPLACE FUNCTION public.candy_park_unresolved_sale(
  p_signature   text,
  p_token_mint  text,
  p_block_time  timestamptz,
  p_price_sol   numeric,
  p_buyer       text,
  p_seller      text,
  p_skip_reason text
) RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO public.candy_sales_unresolved
    (signature, token_mint, collection_id, block_time, price_sol, buyer, seller, skip_reason)
  VALUES
    (p_signature, p_token_mint, '209ade70-32c5-4470-bc7c-4793d660f713'::uuid,
     p_block_time, p_price_sol, p_buyer, p_seller, p_skip_reason)
  ON CONFLICT (signature, token_mint) DO UPDATE
     SET attempts        = public.candy_sales_unresolved.attempts + 1,
         last_attempt_at = now(),
         skip_reason     = EXCLUDED.skip_reason
   WHERE public.candy_sales_unresolved.resolved_at IS NULL;
$$;
-- <<< END verbatim candy_park_unresolved_sale <<<

-- ── 1. First park inserts a fresh row: attempts=1, unresolved, Candy UUID ────
SELECT public.candy_park_unresolved_sale('sig1', 'mintA', '2026-07-30T10:00:00Z', 0.5, '0xB', '0xS', 'no_edition');
SELECT _assert_eq((SELECT count(*)::text FROM public.candy_sales_unresolved), '1', 'first park inserts one row');
SELECT _assert_eq((SELECT attempts::text FROM public.candy_sales_unresolved WHERE signature='sig1'), '1',
  'first park has attempts=1 (table default)');
SELECT _assert_eq((SELECT skip_reason FROM public.candy_sales_unresolved WHERE signature='sig1'), 'no_edition',
  'first park records the skip_reason');
SELECT _assert_eq((SELECT collection_id::text FROM public.candy_sales_unresolved WHERE signature='sig1'),
  '209ade70-32c5-4470-bc7c-4793d660f713', 'always stamps the fixed Candy MLB collection UUID');

-- ── 2. Re-park while UNRESOLVED bumps attempts + refreshes skip_reason ───────
SELECT public.candy_park_unresolved_sale('sig1', 'mintA', '2026-07-30T10:00:00Z', 0.5, '0xB', '0xS', 'still_no_edition');
SELECT _assert_eq((SELECT count(*)::text FROM public.candy_sales_unresolved), '1',
  're-park of the same (signature, token_mint) does not add a row');
SELECT _assert_eq((SELECT attempts::text FROM public.candy_sales_unresolved WHERE signature='sig1'), '2',
  're-park while unresolved increments attempts');
SELECT _assert_eq((SELECT skip_reason FROM public.candy_sales_unresolved WHERE signature='sig1'), 'still_no_edition',
  're-park while unresolved refreshes skip_reason to the new value');

-- ── 3. THE KEY GUARD: re-park of an ALREADY-RESOLVED sale is a NO-OP ─────────
UPDATE public.candy_sales_unresolved SET resolved_at = now(), resolution = 'promoted' WHERE signature='sig1';
SELECT public.candy_park_unresolved_sale('sig1', 'mintA', '2026-07-30T10:00:00Z', 0.5, '0xB', '0xS', 'late_duplicate');
SELECT _assert_eq((SELECT attempts::text FROM public.candy_sales_unresolved WHERE signature='sig1'), '2',
  'WHERE resolved_at IS NULL: re-parking a RESOLVED sale must NOT bump attempts');
SELECT _assert_eq((SELECT skip_reason FROM public.candy_sales_unresolved WHERE signature='sig1'), 'still_no_edition',
  'WHERE resolved_at IS NULL: re-parking a RESOLVED sale must NOT overwrite skip_reason');
SELECT _assert_eq((SELECT resolution FROM public.candy_sales_unresolved WHERE signature='sig1'), 'promoted',
  'a resolved sale keeps its resolution — never resurrected by a late duplicate event');

-- ── 4. A different (signature, token_mint) is a distinct parked row ──────────
SELECT public.candy_park_unresolved_sale('sig2', 'mintB', '2026-07-30T11:00:00Z', 1.2, NULL, NULL, 'burnt');
SELECT _assert_eq((SELECT count(*)::text FROM public.candy_sales_unresolved), '2',
  'a different (signature, token_mint) parks as its own row');
-- Same signature but a DIFFERENT token_mint is also distinct (composite key).
SELECT public.candy_park_unresolved_sale('sig1', 'mintC', '2026-07-30T12:00:00Z', 0.9, NULL, NULL, 'pack');
SELECT _assert_eq((SELECT count(*)::text FROM public.candy_sales_unresolved), '3',
  'the conflict key is the (signature, token_mint) PAIR, not signature alone');

SELECT '✓ candy_park_unresolved_sale invariants pass' AS result;
ROLLBACK;

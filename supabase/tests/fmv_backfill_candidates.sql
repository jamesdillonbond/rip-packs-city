-- DB invariant: public.fmv_backfill_candidates — the anti-join that picks which
-- editions still need a FIRST FMV snapshot. It returns editions that have at
-- least one POSITIVE-price sale but NO fmv_snapshots row yet, deduped, capped.
-- If this over-returns (e.g. drops the price>0 or the NOT EXISTS guard) the
-- backfill wastes work re-pricing already-priced editions or tries to price
-- editions with no real sale; if it under-returns, genuinely-unpriced editions
-- never get a first FMV. The LIMIT is clamped to [1, 500] regardless of p_limit.
--
-- The function DDL below is VERBATIM from the committed migration
-- (supabase/migrations/20260626001900_fmv_backfill_candidates_antijoin_rpc.sql),
-- verified byte-identical to the live prod definition via pg_get_functiondef on
-- 2026-07-31. __tests__/db-invariants-drift-guard.test.ts fails CI on drift.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE public.sales (edition_id uuid, price_usd numeric);
CREATE TABLE public.fmv_snapshots (edition_id uuid);

-- >>> BEGIN verbatim fmv_backfill_candidates (byte-identical to the migration/prod) >>>
CREATE OR REPLACE FUNCTION public.fmv_backfill_candidates(p_limit integer DEFAULT 100)
RETURNS TABLE(ed_id uuid)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
SET statement_timeout = '60s'
AS $$
  SELECT s.edition_id
  FROM public.sales s
  WHERE s.price_usd > 0
    AND s.edition_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM public.fmv_snapshots f WHERE f.edition_id = s.edition_id
    )
  GROUP BY s.edition_id
  LIMIT GREATEST(1, LEAST(p_limit, 500));
$$;
-- <<< END verbatim fmv_backfill_candidates <<<

\set unpriced   '''11111111-1111-1111-1111-111111111111'''
\set alreadyfmv '''22222222-2222-2222-2222-222222222222'''
\set zeroprice  '''33333333-3333-3333-3333-333333333333'''

INSERT INTO public.sales (edition_id, price_usd) VALUES
  (:unpriced::uuid, 10.0),          -- positive sale, no snapshot → CANDIDATE
  (:unpriced::uuid, 20.0),          -- second sale of same edition → still ONE row (GROUP BY)
  (:alreadyfmv::uuid, 15.0),        -- positive sale but HAS a snapshot → excluded
  (:zeroprice::uuid, 0.0),          -- edition_id set but price 0 → excluded
  (NULL, 99.0);                     -- null edition_id → excluded
INSERT INTO public.fmv_snapshots (edition_id) VALUES (:alreadyfmv::uuid);

-- Exactly the unpriced edition is a candidate, and only once.
SELECT _assert_eq((SELECT count(*)::text FROM public.fmv_backfill_candidates(100)), '1',
  'only the positive-sale, no-snapshot edition is a candidate (deduped to one row)');
SELECT _assert_eq((SELECT string_agg(ed_id::text, ',') FROM public.fmv_backfill_candidates(100)),
  '11111111-1111-1111-1111-111111111111',
  'the candidate is the unpriced edition — priced/zero-price/null-edition rows excluded');

-- The limit is clamped: p_limit <= 0 still yields at least 1 (GREATEST(1, ...)).
SELECT _assert_eq((SELECT count(*)::text FROM public.fmv_backfill_candidates(0)), '1',
  'p_limit of 0 is clamped up to 1 (GREATEST) — still returns the candidate');

-- Once the candidate gets a snapshot it drops out (the NOT EXISTS anti-join).
INSERT INTO public.fmv_snapshots (edition_id) VALUES (:unpriced::uuid);
SELECT _assert_eq((SELECT count(*)::text FROM public.fmv_backfill_candidates(100)), '0',
  'once an edition has a snapshot it is no longer a backfill candidate');

SELECT '✓ fmv_backfill_candidates invariants pass' AS result;
ROLLBACK;

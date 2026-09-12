-- DB invariant: public.fmv_backfill_candidates — the anti-join that picks which
-- editions still need a FIRST FMV snapshot. It returns editions that have at
-- least one POSITIVE-price sale but NO fmv_snapshots row yet, deduped, capped.
-- If this over-returns (e.g. drops the price>0 or the NOT EXISTS guard) the
-- backfill wastes work re-pricing already-priced editions or tries to price
-- editions with no real sale; if it under-returns, genuinely-unpriced editions
-- never get a first FMV. The LIMIT is clamped to [1, 500] regardless of p_limit.
--
-- REWRITTEN 2026-09-11: the function now drives from `editions` (21,423 rows)
-- instead of `sales` (4.9M across eight partitions). Measured warm-vs-warm on one
-- idle instance: 427,727 buffers + 55,406 TEMP blocks / 11,129 ms BEFORE against
-- 75,105 buffers / no temp AFTER. The old shape put `LIMIT 100` above a Sort/Group
-- over a Parallel Hash Anti Join, so with a true answer of ZERO the limit never
-- bound and every tick paid the whole scan — which is why `fmv-backfill` timed out
-- on 8 of its last 12 runs against its own `statement_timeout = '60s'`.
--
-- ⭐ THE EQUIVALENCE RESTS ON A FOREIGN KEY, and that is what the orphan case at
-- the end of this file pins: `sales_edition_id_fkey` FOREIGN KEY (edition_id)
-- REFERENCES editions(id) means a sale can never name an edition that is not in
-- `editions`, so "editions reachable from sales" and "editions with a sale" are
-- the same set. ⚠ Drop that FK and this function silently NARROWS — it would stop
-- returning an orphan the old form would have found. The fixture here has no FK
-- precisely so the behaviour is visible and asserted rather than assumed.
--
-- The function DDL below is VERBATIM from the committed migration
-- (supabase/migrations/20260912063341_audit_20260911_fmv_backfill_candidates_drives_from_editions_not_sales.sql),
-- verified byte-identical to the live prod definition by md5 of the
-- whitespace-normalised `prosrc` on 2026-09-11.
-- __tests__/db-invariants-drift-guard.test.ts fails CI on drift.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE public.editions (id uuid PRIMARY KEY);
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
  SELECT e.id
  FROM public.editions e
  WHERE NOT EXISTS (
      SELECT 1 FROM public.fmv_snapshots f WHERE f.edition_id = e.id
    )
    AND EXISTS (
      SELECT 1 FROM public.sales s
      WHERE s.edition_id = e.id AND s.price_usd > 0
    )
  LIMIT GREATEST(1, LEAST(p_limit, 500));
$$;
-- <<< END verbatim fmv_backfill_candidates <<<

\set unpriced   '''11111111-1111-1111-1111-111111111111'''
\set alreadyfmv '''22222222-2222-2222-2222-222222222222'''
\set zeroprice  '''33333333-3333-3333-3333-333333333333'''

-- Every edition a sale can name must exist, because production enforces that
-- with sales_edition_id_fkey. The orphan case below is the deliberate exception.
INSERT INTO public.editions (id) VALUES
  (:unpriced::uuid), (:alreadyfmv::uuid), (:zeroprice::uuid);

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

-- ⭐ THE FK DEPENDENCY, pinned where the next reader meets it. A sale naming an
-- edition that is NOT in `editions` cannot exist in production (sales_edition_id_fkey),
-- and this form does not return it. If that FK is ever dropped, this assertion is
-- the thing that says the rewrite has silently narrowed — the pre-2026-09-11 form
-- WOULD have returned it.
\set orphan '''44444444-4444-4444-4444-444444444444'''
INSERT INTO public.sales (edition_id, price_usd) VALUES (:orphan::uuid, 42.0);
SELECT _assert_eq((SELECT count(*)::text FROM public.fmv_backfill_candidates(100)), '0',
  'a sale naming an edition absent from `editions` is NOT a candidate — the rewrite reads the FK as an invariant');

SELECT '✓ fmv_backfill_candidates invariants pass' AS result;
ROLLBACK;

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
-- RE-PINNED 2026-10-04: the 09-11 body stopped driving from `editions` -- SQL
-- does not fix a join order, and with `editions` at ~39.6k the planner chose a
-- Merge Semi Join over all eight `sales` partition indexes (> 55 s generic plan;
-- 2 of the last 10 production runs hit the 60 s timeout). The body now finds the
-- snapshot-less editions in a MATERIALIZED CTE first and probes `sales` only for
-- those (441 ms). Same set, same FK dependency, so every assertion below is
-- unchanged and still meaningful -- the CTE is exercised by each of them.
--
-- RE-PINNED 2026-11-10: the sales probe is a per-edition LATERAL ... LIMIT 1 (the EXISTS
-- became a hash semi-join over all 7.55M sales rows once the unpriced set reached 21k).
-- Same set, so every assertion below is unchanged.
--
-- RE-PINNED 2026-11-10 (evening): the unpriced set is found through edition_fmv_current first,
-- each survivor confirmed against fmv_snapshots; statement_timeout 60 s -> 90 s. Every
-- assertion above the new ones is unchanged (no fixture edition has an edition_fmv_current
-- row, so the snapshot check alone decides them, exactly as before). Two new cases pin the
-- prefilter's contract: a LAGGING edition_fmv_current (snapshot written, cache row not yet)
-- does not resurrect a priced edition, and a STALE-AHEAD row (cache row, no snapshot behind
-- it) excludes the edition — the deliberate narrowing.
--
-- The function DDL below is VERBATIM from the committed migration
-- (supabase/migrations/20261111014609_audit_20261110_fmv_backfill_candidates_prefilters_on_edition_fmv_current.sql),
-- verified against the live prod body by md5 of `prosrc` on 2026-11-10.
-- __tests__/db-invariants-drift-guard.test.ts fails CI on drift.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE public.editions (id uuid PRIMARY KEY);
CREATE TABLE public.sales (edition_id uuid, price_usd numeric);
CREATE TABLE public.fmv_snapshots (edition_id uuid);
CREATE TABLE public.edition_fmv_current (edition_id uuid PRIMARY KEY);

-- >>> BEGIN verbatim fmv_backfill_candidates (byte-identical to the migration/prod) >>>
CREATE OR REPLACE FUNCTION public.fmv_backfill_candidates(p_limit integer DEFAULT 100)
RETURNS TABLE(ed_id uuid)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
SET statement_timeout = '90s'
AS $$
  -- 2026-11-10 (evening): the unpriced set is found through edition_fmv_current FIRST (one row
  -- per priced edition; a hash anti-join over ~67k rows), and only its survivors are confirmed
  -- against fmv_snapshots. The old NOT EXISTS read the whole fmv_snapshots_2026 edition index
  -- (2.9M entries, 256k buffers, ~17.6k cold reads = most of a cold run's IO). A lagging
  -- edition_fmv_current only adds survivors that the snapshot check then removes, so the set is
  -- unchanged; an edition_fmv_current row with NO snapshot behind it is excluded (pinned).
  WITH unpriced AS MATERIALIZED (
    SELECT e.id
    FROM public.editions e
    WHERE NOT EXISTS (
        SELECT 1 FROM public.edition_fmv_current c WHERE c.edition_id = e.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.fmv_snapshots f WHERE f.edition_id = e.id
      )
  )
  -- 2026-11-10: the sales probe is a per-edition LATERAL ... LIMIT 1, not EXISTS. With the
  -- unpriced set at 21,326 (all Candy census editions) the planner turned EXISTS into a hash
  -- semi-join over all 7.55M sales rows (2.9M buffers, 23 s idle; two 60 s timeouts) for an
  -- answer of ZERO. A LATERAL with LIMIT 1 cannot be flattened into a join, so each unpriced
  -- edition is one index probe per partition: 610k buffers / 1.6 s. Same set.
  SELECT u.id
  FROM unpriced u
  CROSS JOIN LATERAL (
      SELECT 1 FROM public.sales s
      WHERE s.edition_id = u.id AND s.price_usd > 0
      LIMIT 1
    ) has_sale
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

-- ⭐ THE edition_fmv_current PREFILTER (2026-11-10 evening).
\set lagging   '''55555555-5555-5555-5555-555555555555'''
\set staleahd  '''66666666-6666-6666-6666-666666666666'''
\set fresh     '''77777777-7777-7777-7777-777777777777'''
INSERT INTO public.editions (id) VALUES (:lagging::uuid), (:staleahd::uuid), (:fresh::uuid);
INSERT INTO public.sales (edition_id, price_usd) VALUES (:lagging::uuid, 5.0), (:staleahd::uuid, 6.0), (:fresh::uuid, 7.0);
-- lagging: a snapshot exists but edition_fmv_current has no row yet -> the snapshot check excludes it
INSERT INTO public.fmv_snapshots (edition_id) VALUES (:lagging::uuid);
-- stale-ahead: edition_fmv_current names it but no snapshot exists -> excluded by design
INSERT INTO public.edition_fmv_current (edition_id) VALUES (:staleahd::uuid);
SELECT _assert_eq((SELECT string_agg(ed_id::text, ',') FROM public.fmv_backfill_candidates(100)),
  '77777777-7777-7777-7777-777777777777',
  'prefilter: only the truly unpriced sold edition is a candidate — a lagging edition_fmv_current does not resurrect a priced edition, and a stale-ahead row excludes its edition');
-- CONTROL: the fresh edition drops out once its snapshot lands, with no cache row at all
INSERT INTO public.fmv_snapshots (edition_id) VALUES (:fresh::uuid);
SELECT _assert_eq((SELECT count(*)::text FROM public.fmv_backfill_candidates(100)), '0',
  'prefilter CONTROL: a snapshot alone (no edition_fmv_current row) removes the edition');

SELECT '✓ fmv_backfill_candidates invariants pass' AS result;
ROLLBACK;

-- DB invariant: public.refresh_wmc_fmv_changed — the incremental propagation of
-- newly-computed FMV into wallet_moments_cache, on pg_cron `7-57/10 * * * *`
-- (jobid 303).
--
-- WHY IT MATTERS. wmc is the portfolio store: ~34 DB functions sum wmc.fmv_usd
-- for a collector's total, and /share/[wallet] publishes it. This function is
-- what keeps that number in step with fmv_snapshots. When it silently failed
-- 57014 on every tick for 10+ hours (2026-08-12), the drift reached Top Shot 7%
-- exact-match and AllDay p95 14.2x against fmv_current — with pipeline_runs
-- showing 988 runs and ZERO failures, because the RPC's only failure signal was
-- a console.log. It is also the platform's #1 WRITER — re-measured 2026-08-26
-- over a 14.5-day pg_stat_statements window: 36.7% of every block the database
-- dirties, 33.9% of WAL, 8.9% of disk reads, 148 exec-hours (~10.2 h/day) — so
-- its churn-avoidance clause is an IO-budget property, not a micro-optimisation.
--
-- The function DDL below is VERBATIM from the committed migration
-- (supabase/migrations/20260826143452_audit_20260826_rwfc_freshness_guarded_edition_fmv_current.sql),
-- whose body is byte-identical to live prod: prosrc 4,730 chars,
-- md5(pg_get_functiondef(...)) = 7e6c414075038f3337967910a2df13f7, read from the
-- database on 2026-08-26. __tests__/db-invariants-drift-guard.test.ts fails CI on drift.
--
-- ⚠ RE-PINNED 2026-08-26 onto the freshness-guarded edition_fmv_current fast path,
-- and the ASSERTIONS BELOW WERE RE-READ FIRST — that is the whole job, not the DDL
-- paste. Clause counts against the LIVE body, **comments stripped** (see the warning
-- below about why that matters):
--   fmv_usd IS NOT NULL              x4   (was x3; the new one is the cache-null clause)
--   IS DISTINCT FROM                 x1   (the churn guard)
--   edition_key IS NOT NULL          x1
--   rwfc_state                       x2   (cursor read + write)
--   DISTINCT ON                      x1
--   MATERIALIZED                     x2
--   edition_fmv_current              x1   (NEW — the cache join)
--   computed_at >= p.computed_at     x1   (NEW — the freshness guard)
--   RETURNING edition_id, computed_at x1  (NEW — feeds the guard)
--
-- ⚠ THE PREVIOUS HEADER'S COUNTS WERE RAW SUBSTRING COUNTS AND THREE OF THEM WERE
-- COMMENT-CONTAMINATED. Measured 2026-08-26: raw vs comment-stripped is
-- `fmv_usd IS NOT NULL` 5 vs 4, `DISTINCT ON` 3 vs 1, `MATERIALIZED` 3 vs 2 — the
-- body's own explanatory comments contain the phrases ("...a MATERIALIZED CTE so the
-- planner...", "...DISTINCT ON's ordering..."). So the old header's "DISTINCT ON x2"
-- and "MATERIALIZED went 1 -> 3" were counting prose. **Strip comments before
-- counting a clause in a function body**, exactly as the repo's guards must.
--
-- ⚠ A substring probe CANNOT check MATERIALIZED by presence — a June migration
-- already put one in the LOOP body, so `position('MATERIALIZED' in prosrc) > 0` was
-- already TRUE before the 08-22 change. Count occurrences and read the build statement.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE public.editions (
  id            uuid primary key,
  collection_id uuid,
  external_id   text
);

CREATE TABLE public.fmv_snapshots (
  edition_id  uuid,
  fmv_usd     numeric,
  computed_at timestamptz
);

CREATE TABLE public.wallet_moments_cache (
  id             bigserial primary key,
  wallet_address text,
  collection_id  uuid,
  edition_key    text,
  fmv_usd        numeric
);

CREATE TABLE public.rwfc_state (
  id          int primary key,
  last_cutoff timestamptz
);

-- The read-side cache the fast path consults. Real shape has more columns; only
-- these three are read by this function.
CREATE TABLE public.edition_fmv_current (
  edition_id  uuid primary key,
  fmv_usd     numeric,
  computed_at timestamptz
);

-- >>> BEGIN verbatim refresh_wmc_fmv_changed (byte-identical to the migration/prod) >>>
CREATE OR REPLACE FUNCTION public.refresh_wmc_fmv_changed(p_since_minutes integer DEFAULT 30, p_limit integer DEFAULT 50000)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_total      integer := 0;
  v_batch      integer;
  v_cutoff     timestamptz;
  v_new_cutoff timestamptz;
  v_run_start  timestamptz := clock_timestamp();
  v_timeout_ms bigint;
  v_budget     interval;
  v_deadline   timestamptz;
  -- Sized to fit the SMALLEST caller budget (service_role 30s), never scaled up.
  v_chunk      constant integer := 5;
BEGIN
  SELECT setting::bigint INTO v_timeout_ms FROM pg_settings WHERE name = 'statement_timeout';

  IF v_timeout_ms IS NULL OR v_timeout_ms = 0 THEN
    v_budget := interval '300 seconds';
  ELSE
    v_budget := GREATEST(make_interval(secs => (v_timeout_ms / 1000.0) * 0.6),
                         interval '5 seconds');
  END IF;
  v_deadline := clock_timestamp() + v_budget;

  SELECT last_cutoff INTO v_cutoff FROM public.rwfc_state WHERE id = 1;
  IF v_cutoff IS NULL THEN
    v_cutoff := v_run_start - make_interval(mins => GREATEST(p_since_minutes, 1));
  END IF;

  DROP TABLE IF EXISTS _rwfc_recent;
  -- The filter is wrapped in a MATERIALIZED CTE so the planner cannot use
  -- fmv_snapshots_2026_edition_id_computed_at_idx to supply DISTINCT ON's ordering
  -- for free. That index leads on edition_id while the predicate is on computed_at,
  -- so there is no range to seek and the whole 2026 index is walked -- on a 418x row
  -- overestimate. Materialising first removes the ordering incentive; the planner
  -- then seeks idx_fmv_snapshots_2026_computed_at_desc and pays a tiny quicksort.
  -- Measured 2026-08-22, warm-vs-warm, same 563 output rows: 8,402 buffers / 471 ms
  -- as written vs 29 buffers / 0.98 ms wrapped. Output diffed with EXCEPT in BOTH
  -- directions: 0 rows only-in-incumbent, 0 rows only-in-candidate.
  CREATE TEMP TABLE _rwfc_recent ON COMMIT DROP AS
  WITH recent AS MATERIALIZED (
    SELECT fs.edition_id, fs.computed_at
    FROM public.fmv_snapshots fs
    WHERE fs.computed_at > v_cutoff
      AND fs.fmv_usd IS NOT NULL
  )
  SELECT DISTINCT ON (r.edition_id) r.edition_id, r.computed_at
  FROM recent r
  ORDER BY r.edition_id, r.computed_at DESC;
  CREATE INDEX ON _rwfc_recent (computed_at);
  ANALYZE _rwfc_recent;

  LOOP
    WITH popped AS (
      DELETE FROM _rwfc_recent
       WHERE edition_id IN (
         SELECT edition_id FROM _rwfc_recent ORDER BY computed_at LIMIT v_chunk
       )
      RETURNING edition_id, computed_at
    ),
    latest_fmv AS MATERIALIZED (
      SELECT e.collection_id, e.external_id,
        -- FAST PATH FIRST. COALESCE evaluates left to right and stops at the first
        -- non-null, so the SubPlan below only runs for the rows the freshness guard
        -- rejected. That is the entire saving: no partition Append for ~85% of rows.
        COALESCE(
          efc.fmv_usd,
          (SELECT f.fmv_usd
             FROM public.fmv_snapshots f
            WHERE f.edition_id = e.id
              AND f.fmv_usd IS NOT NULL
            ORDER BY f.computed_at DESC
            LIMIT 1)
        ) AS fmv_usd
      FROM popped p
      JOIN public.editions e ON e.id = p.edition_id
      -- BOTH extra clauses are load-bearing and neither is a tidy-up:
      --   computed_at >= p.computed_at  -- the cache must not be BEHIND the snapshot
      --                                    that queued this edition (28 of 4,028 were)
      --   fmv_usd IS NOT NULL           -- the cache's DISTINCT ON does not filter
      --                                    nulls while the subquery does; without this
      --                                    a NULL latest snapshot would take the fast
      --                                    path and blank a real price
      LEFT JOIN public.edition_fmv_current efc
             ON efc.edition_id  = e.id
            AND efc.computed_at >= p.computed_at
            AND efc.fmv_usd IS NOT NULL
    ),
    updated AS (
      UPDATE public.wallet_moments_cache wmc
         SET fmv_usd = lf.fmv_usd
        FROM latest_fmv lf
       WHERE wmc.collection_id = lf.collection_id
         AND wmc.edition_key   = lf.external_id
         AND wmc.edition_key IS NOT NULL
         AND lf.fmv_usd IS NOT NULL
         AND wmc.fmv_usd IS DISTINCT FROM lf.fmv_usd
      RETURNING 1
    )
    SELECT COUNT(*)::int INTO v_batch FROM updated;

    v_total := v_total + COALESCE(v_batch, 0);

    EXIT WHEN NOT EXISTS (SELECT 1 FROM _rwfc_recent);
    EXIT WHEN clock_timestamp() > v_deadline;
    EXIT WHEN v_total >= p_limit;
  END LOOP;

  SELECT MIN(computed_at) - interval '1 microsecond' INTO v_new_cutoff FROM _rwfc_recent;
  v_new_cutoff := COALESCE(v_new_cutoff, v_run_start);

  INSERT INTO public.rwfc_state (id, last_cutoff) VALUES (1, v_new_cutoff)
  ON CONFLICT (id) DO UPDATE SET last_cutoff = EXCLUDED.last_cutoff;

  RETURN v_total;
END;
$function$;
-- <<< END verbatim refresh_wmc_fmv_changed <<<

-- Two collections so the join's collection scoping is exercised.
INSERT INTO public.editions (id, collection_id, external_id) VALUES
  ('11111111-1111-1111-1111-111111111111', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '48:1652'),
  ('22222222-2222-2222-2222-222222222222', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '121:4255'),
  ('33333333-3333-3333-3333-333333333333', 'dee28451-5d62-409e-a1ad-a83f763ac070', '48:1652');

-- Edition 1 has TWO snapshots; only the NEWEST may propagate.
INSERT INTO public.fmv_snapshots (edition_id, fmv_usd, computed_at) VALUES
  ('11111111-1111-1111-1111-111111111111', 100.00, now() - interval '5 minutes'),
  ('11111111-1111-1111-1111-111111111111', 250.00, now() - interval '1 minute'),
  ('22222222-2222-2222-2222-222222222222',  42.00, now() - interval '2 minutes'),
  ('33333333-3333-3333-3333-333333333333', 999.00, now() - interval '2 minutes');

INSERT INTO public.wallet_moments_cache (wallet_address, collection_id, edition_key, fmv_usd) VALUES
  ('0xA', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '48:1652',  NULL),   -- never priced
  ('0xB', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '48:1652',  100.00), -- stale price
  ('0xC', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '121:4255', 42.00),  -- ALREADY correct
  ('0xD', 'dee28451-5d62-409e-a1ad-a83f763ac070', '48:1652',  NULL),   -- other collection
  ('0xE', '95f28a17-224a-4025-96ad-adf8a4c63bfd', NULL,       NULL);   -- unkeyed row

-- edition_fmv_current is deliberately EMPTY for this whole first block. That makes
-- it the CACHE-ABSENT control: every assertion below therefore exercises the FALLBACK
-- (correlated-subquery) path, and proves the 2026-08-26 fast path did not change any
-- behaviour when the cache has nothing to offer. The fast path gets its own block at
-- the bottom of this file.

-- 3 rows change: 0xA, 0xB (Top Shot 48:1652) and 0xD (AllDay 48:1652).
-- 0xC is already correct and must NOT be rewritten -- see the churn note below.
SELECT _assert_eq(public.refresh_wmc_fmv_changed()::text, '3',
  'only the rows whose value actually changes are updated');

-- The LATEST snapshot wins.
-- Taking any other row would publish a superseded price as the current one, on
-- the number a collector reads as their portfolio total.
SELECT _assert_eq(
  (SELECT fmv_usd::text FROM public.wallet_moments_cache WHERE wallet_address='0xB'), '250.00',
  'the newest snapshot per edition is the one propagated');
SELECT _assert_eq(
  (SELECT fmv_usd::text FROM public.wallet_moments_cache WHERE wallet_address='0xA'), '250.00',
  'a previously-unpriced row is filled');

-- The join is (collection_id, edition_key), not edition_key alone.
-- external_id "48:1652" exists in BOTH collections here, deliberately: Top Shot
-- keys are not unique across collections, so dropping the collection predicate
-- cross-contaminates two collections' prices.
SELECT _assert_eq(
  (SELECT fmv_usd::text FROM public.wallet_moments_cache WHERE wallet_address='0xD'), '999.00',
  'the AllDay row gets the ALLDAY price for the same edition key');

-- Rows with a NULL edition_key are never written.
-- NOTE the explicit `wmc.edition_key IS NOT NULL` clause in the UPDATE is
-- REDUNDANT and is deliberately NOT asserted on its own: `wmc.edition_key =
-- lf.external_id` already yields NULL (never true) for a NULL key, so removing
-- the clause changes nothing -- verified by mutation, which SURVIVED. The
-- assertion below pins the BEHAVIOUR, which is what callers depend on. It would
-- become load-bearing again if the join ever moved to a NULL-safe operator
-- (`IS NOT DISTINCT FROM`) or a COALESCE on either side.
SELECT _assert(
  (SELECT fmv_usd FROM public.wallet_moments_cache WHERE wallet_address='0xE') IS NULL,
  'an unkeyed wmc row is never written');

-- THE CHURN GUARD (IS DISTINCT FROM).
-- This is an IO-budget property on the platform's #1 writer. Without it,
-- every tick rewrites every matched row -- sustained HOT-update churn on a
-- 2.2M-row table on a disk-IO-throttled instance -- and the return value stops
-- meaning "rows that changed", which is the only signal that the propagation is
-- doing anything.
DELETE FROM public.rwfc_state;
SELECT _assert_eq(public.refresh_wmc_fmv_changed()::text, '0',
  're-running with no new snapshots updates nothing');

-- A NULL-priced snapshot never blanks an existing wmc price.
-- `fmv_usd IS NOT NULL` appears FOUR times: building _rwfc_recent, selecting
-- the latest snapshot, the edition_fmv_current join, and the UPDATE.
--
-- MEASURED, not assumed: the three ORIGINAL ones are MUTUALLY REDUNDANT
-- defence-in-depth. Removing any ONE leaves the behaviour correct, and removing
-- any TWO still does; only removing ALL THREE blanks a real price. Each
-- single-clause mutation therefore SURVIVES this test, and no fixture can change
-- that -- with two guards standing, the third has nothing to catch. This is a
-- deliberate design property, so the assertion below pins the BEHAVIOUR rather
-- than pretending to pin each clause. A future edit that removes two of the three
-- is the dangerous one: individually harmless, and it leaves the portfolio value
-- one edit from being wiped with this test still green.
-- The FOURTH (`efc.fmv_usd IS NOT NULL`) is NOT part of that redundancy and is
-- discussed at the 0xH assertion at the bottom of this file.
INSERT INTO public.fmv_snapshots (edition_id, fmv_usd, computed_at)
VALUES ('11111111-1111-1111-1111-111111111111', NULL, now());
DELETE FROM public.rwfc_state;
SELECT _assert_eq(public.refresh_wmc_fmv_changed()::text, '0',
  'a NULL-priced snapshot does not even enter the queue, so nothing is rewritten');
SELECT _assert_eq(
  (SELECT fmv_usd::text FROM public.wallet_moments_cache WHERE wallet_address='0xB'), '250.00',
  'and the existing price is untouched');

-- The cursor advances, so the next tick does not re-scan.
-- rwfc_state is what makes this incremental. If it stopped advancing the sweep
-- would re-read the same window forever -- which on this function means re-doing
-- the largest disk read on the instance every ten minutes.
SELECT _assert(
  (SELECT last_cutoff FROM public.rwfc_state WHERE id = 1) IS NOT NULL,
  'the cursor is persisted after a run');
SELECT _assert(
  (SELECT last_cutoff FROM public.rwfc_state WHERE id = 1) > now() - interval '1 minute',
  'a fully-drained queue advances the cursor to the run start, not backwards');

-- ================= THE FRESHNESS-GUARDED FAST PATH (added 2026-08-26) =============
--
-- WHY THIS BLOCK EXISTS. The fast path reads the latest FMV from
-- edition_fmv_current instead of the correlated subquery, which is where ~36.7%
-- of the instance's dirtied blocks came from. The obvious form of that fix -- a
-- bare COALESCE onto the cache -- is WRONG and was retracted before shipping:
-- measured over the population this function actually serves (4,028 editions with
-- an FMV change in 6h), the cache LAGS 28 of them, by as much as -59%/+39%, and
-- those values would have gone straight into a DISPLAYED PRICE. The function's own
-- `IS DISTINCT FROM` churn guard cannot catch that, because "stale" and "correct"
-- are both distinct from what is already stored.
--
-- Each of the three branches below is made OBSERVABLE by a fixture whose cache
-- value DISAGREES with its snapshot. That is deliberate and cannot happen in
-- production -- it is the only way to tell from the OUTPUT which branch executed.
-- Asserting only "the right price came out" would pass for all three even if the
-- LEFT JOIN were deleted entirely.
INSERT INTO public.editions (id, collection_id, external_id) VALUES
  ('44444444-4444-4444-4444-444444444444', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '77:100'),
  ('55555555-5555-5555-5555-555555555555', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '77:200'),
  ('66666666-6666-6666-6666-666666666666', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '77:300');

INSERT INTO public.fmv_snapshots (edition_id, fmv_usd, computed_at) VALUES
  ('44444444-4444-4444-4444-444444444444', 500.00, now() - interval '1 minute'),
  ('55555555-5555-5555-5555-555555555555', 700.00, now() - interval '1 minute'),
  ('66666666-6666-6666-6666-666666666666', 800.00, now() - interval '1 minute');

INSERT INTO public.edition_fmv_current (edition_id, fmv_usd, computed_at) VALUES
  -- FRESH, and deliberately 501 rather than 500 so that taking the fast path is
  -- visible in the output.
  ('44444444-4444-4444-4444-444444444444', 501.00, now() - interval '1 minute'),
  -- STALE by 7 days AND wrong. This is the retracted bug, as a fixture.
  ('55555555-5555-5555-5555-555555555555', 100.00, now() - interval '7 days'),
  -- FRESH but NULL -- the cache's own DISTINCT ON does not filter nulls while the
  -- subquery does, so this row must not be allowed to serve the fast path.
  ('66666666-6666-6666-6666-666666666666', NULL,   now() - interval '1 minute');

INSERT INTO public.wallet_moments_cache (wallet_address, collection_id, edition_key, fmv_usd) VALUES
  ('0xF', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '77:100', NULL),
  ('0xG', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '77:200', NULL),
  ('0xH', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '77:300', NULL);

DELETE FROM public.rwfc_state;
SELECT _assert_eq(public.refresh_wmc_fmv_changed()::text, '3',
  'exactly the three new rows change; editions 1-3 are already correct and are not rewritten');

-- MUTATION CAUGHT: deleting the LEFT JOIN, or the COALESCE, so every row falls back
-- to the subquery. Then 0xF reads 500.00 and this flips.
--
-- It also pins the BOUNDARY, deliberately. Edition 4's cache row and its snapshot
-- both use `now() - interval '1 minute'`, and now() is constant within a
-- transaction, so their computed_at values are EXACTLY EQUAL. That makes this the
-- test for `>=` rather than `>`: tightening the guard to a strict `>` would push
-- edition 4 onto the fallback and read 500.00 here. Equality is the common case in
-- production too -- the cache is built from the same snapshot rows -- so a strict
-- `>` would quietly disable the fast path for most editions while every value
-- stayed correct, i.e. it would cost the entire saving and nothing would notice.
SELECT _assert_eq(
  (SELECT fmv_usd::text FROM public.wallet_moments_cache WHERE wallet_address='0xF'), '501.00',
  'a cache row at least as fresh as the queued snapshot IS used (the fast path runs)');

-- THE LOAD-BEARING ONE. MUTATION CAUGHT: removing `efc.computed_at >= p.computed_at`
-- -- i.e. the bare COALESCE that was retracted -- makes this read 100.00.
SELECT _assert_eq(
  (SELECT fmv_usd::text FROM public.wallet_moments_cache WHERE wallet_address='0xG'), '700.00',
  'a STALE cache row is REJECTED and the true latest snapshot wins');

-- MUTATION NOT CAUGHT BY THIS ASSERTION, AND THAT IS STATED RATHER THAN IMPLIED:
-- removing `efc.fmv_usd IS NOT NULL` from the join lets the row join, but COALESCE
-- then sees a NULL first argument and still falls through to the subquery -- so the
-- VALUE is unchanged and this stays green. It is pinned here as a BEHAVIOUR (a
-- fresh-but-NULL cache row never suppresses a real price), not as a claim to catch
-- that clause's removal. The clause's real job is to stop the fast path claiming a
-- row it cannot serve, which is a plan property no output assertion can see.
SELECT _assert_eq(
  (SELECT fmv_usd::text FROM public.wallet_moments_cache WHERE wallet_address='0xH'), '800.00',
  'a fresh cache row holding NULL falls through to the snapshot and never blanks a price');

SELECT '✓ refresh_wmc_fmv_changed invariants pass' AS result;
ROLLBACK;

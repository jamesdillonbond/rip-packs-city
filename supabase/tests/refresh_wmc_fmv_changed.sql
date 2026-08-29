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
-- a console.log. It is also the platform's #2 disk reader (112 GB), so its
-- churn-avoidance clause is an IO-budget property, not a micro-optimisation.
--
-- ⚠ REVERTED 2026-08-28 off the freshness-guarded edition_fmv_current fast path,
-- back to this (incumbent) body. The fast path shipped with a PRE-REGISTERED exit
-- condition — "re-read in a quiet window >= 24 h out; if reads are still not below
-- the T1 per-call figures (74,159 cron / 7,195 PostgREST) it is not paying for
-- itself and should be reverted" — and the reading FAILED on both callers:
-- pg_cron 87,352 (+17.8%), PostgREST 10,029 (+39.4%), confirmed by a second
-- independent window on a quiet instance. It is a real two-resource trade
-- (~26.5% less wall time for ~18.5% more disk reads) and reads are the right
-- metric because this instance is IO-bound, not CPU-bound.
-- ⛔ Do NOT restore the fast path without a NEW measurement that clears that bar.
-- ✅ Reverting costs no correctness: the freshness guard was scaffolding for the
-- optimisation, and rows failing it already fell through to this exact subquery.
--
-- The function DDL below is VERBATIM from the committed migration
-- (supabase/migrations/20260828053000_audit_20260828_rwfc_revert_freshness_guarded_fast_path.sql),
-- which RESTORES this body verbatim from
-- supabase/migrations/20260822213000_audit_20260822_rwfc_temp_build_materialized_cte.sql.
-- whose body is byte-identical to live prod: prosrc 3,648 chars,
-- md5(pg_get_functiondef(...)) = 7094783150faf1b39148dc3c213d1e18, read from the
-- database on 2026-08-24. __tests__/db-invariants-drift-guard.test.ts fails CI on drift.
--
-- ⚠ RE-PINNED 2026-08-24, and the ASSERTIONS BELOW WERE RE-READ FIRST — that is the
-- whole job, not the DDL paste. `db-pin-staleness` went red on 08-23/08-24 because
-- `audit_20260822_rwfc_temp_build_materialized_cte` was applied to prod, changing the
-- live body; the previous pin named the 08-13 migration. The check's own warning is
-- "a stale pin usually means the assertions describe old behaviour", so every property
-- this file asserts was re-counted against the LIVE body before re-pointing:
--   fmv_usd IS NOT NULL      x3   (the "appears THREE times" note below still holds)
--   IS DISTINCT FROM         x1   (the churn guard)
--   edition_key IS NOT NULL  x1
--   rwfc_state               x2   (cursor read + write)
--   DISTINCT ON              x2
-- All intact: the change is a planner-level CTE materialisation, so it moves no
-- behaviour any assertion here depends on. MATERIALIZED went 1 -> 3.
-- ⚠ A substring probe CANNOT check that last one — a June migration already put one
-- MATERIALIZED in the LOOP body, so `position('MATERIALIZED' in prosrc) > 0` was
-- already TRUE before this change. Count occurrences and read the build statement.
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

-- >>> BEGIN verbatim refresh_wmc_fmv_changed (byte-identical to the migration/prod) >>>
CREATE OR REPLACE FUNCTION public.refresh_wmc_fmv_changed(
  p_since_minutes integer DEFAULT 30,
  p_limit integer DEFAULT 50000
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
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
  -- Two callers run this same non-reentrant drain: pg_cron jobid 303 (`7-57/10`, median 240 s)
  -- and app/api/wmc-fmv-populate/route.ts (every 5 min, ~18 s budget). The route's tick one
  -- minute after jobid 303 used to block on wmc row locks and die -- 83 of 84 lock timeouts in
  -- 48 h landed on :08/:18/:28/:38/:48/:58. Skip instead of blocking; the other instance is
  -- draining the same rwfc_state cursor, so nothing is lost.
  -- ⚠ _xact_ is required: Supabase pools connections, so a leaked session-level advisory lock
  -- would be inherited by an unrelated request and wedge this function permanently.
  -- 🚨 NULL, not 0 -- `rows_written = 0` already means three different things here and a skip
  -- must not become the fourth. The route reads NULL as `skipped_concurrent_refresh`.
  IF NOT pg_try_advisory_xact_lock(hashtext('refresh_wmc_fmv_changed')::bigint) THEN
    RETURN NULL;
  END IF;

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
      RETURNING edition_id
    ),
    latest_fmv AS MATERIALIZED (
      SELECT e.collection_id, e.external_id,
        (SELECT f.fmv_usd
           FROM public.fmv_snapshots f
          WHERE f.edition_id = e.id
            AND f.fmv_usd IS NOT NULL
          ORDER BY f.computed_at DESC
          LIMIT 1) AS fmv_usd
      FROM popped p
      JOIN public.editions e ON e.id = p.edition_id
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

-- 3 rows change: 0xA, 0xB (Top Shot 48:1652) and 0xD (AllDay 48:1652).
-- 0xC is already correct and must NOT be rewritten — see the churn note below.
SELECT _assert_eq(public.refresh_wmc_fmv_changed()::text, '3',
  'only the rows whose value actually changes are updated');

-- ── The LATEST snapshot wins ───────────────────────────────────────────────
-- Taking any other row would publish a superseded price as the current one, on
-- the number a collector reads as their portfolio total.
SELECT _assert_eq(
  (SELECT fmv_usd::text FROM public.wallet_moments_cache WHERE wallet_address='0xB'), '250.00',
  'the newest snapshot per edition is the one propagated');
SELECT _assert_eq(
  (SELECT fmv_usd::text FROM public.wallet_moments_cache WHERE wallet_address='0xA'), '250.00',
  'a previously-unpriced row is filled');

-- ── The join is (collection_id, edition_key), not edition_key alone ────────
-- external_id "48:1652" exists in BOTH collections here, deliberately: Top Shot
-- keys are not unique across collections, so dropping the collection predicate
-- cross-contaminates two collections' prices.
SELECT _assert_eq(
  (SELECT fmv_usd::text FROM public.wallet_moments_cache WHERE wallet_address='0xD'), '999.00',
  'the AllDay row gets the ALLDAY price for the same edition key');

-- ── Rows with a NULL edition_key are never written ────────────────────────
-- ⚠ NOTE the explicit `wmc.edition_key IS NOT NULL` clause in the UPDATE is
-- REDUNDANT and is deliberately NOT asserted on its own: `wmc.edition_key =
-- lf.external_id` already yields NULL (never true) for a NULL key, so removing
-- the clause changes nothing — verified by mutation, which SURVIVED. The
-- assertion below pins the BEHAVIOUR, which is what callers depend on. It would
-- become load-bearing again if the join ever moved to a NULL-safe operator
-- (`IS NOT DISTINCT FROM`) or a COALESCE on either side.
SELECT _assert(
  (SELECT fmv_usd FROM public.wallet_moments_cache WHERE wallet_address='0xE') IS NULL,
  'an unkeyed wmc row is never written');

-- ⚠ THE CHURN GUARD (IS DISTINCT FROM) ────────────────────────────────────
-- This is an IO-budget property on the platform's #2 disk reader. Without it,
-- every tick rewrites every matched row — sustained HOT-update churn on a
-- 2.2M-row table on a disk-IO-throttled instance — and the return value stops
-- meaning "rows that changed", which is the only signal that the propagation is
-- doing anything.
DELETE FROM public.rwfc_state;
SELECT _assert_eq(public.refresh_wmc_fmv_changed()::text, '0',
  're-running with no new snapshots updates nothing');

-- ── A NULL-priced snapshot never blanks an existing wmc price ─────────────
-- `fmv_usd IS NOT NULL` appears THREE times: building _rwfc_recent, selecting
-- the latest snapshot, and in the UPDATE.
--
-- ⚠ MEASURED, not assumed: the three are MUTUALLY REDUNDANT defence-in-depth.
-- Removing any ONE leaves the behaviour correct, and removing any TWO still
-- does; only removing ALL THREE blanks a real price. Each single-clause
-- mutation therefore SURVIVES this test, and no fixture can change that — with
-- two guards standing, the third has nothing to catch. This is a deliberate
-- design property of the function, so the assertion below pins the BEHAVIOUR
-- (the thing callers depend on) rather than pretending to pin each clause.
-- A future edit that removes two of the three is the dangerous one: it is
-- individually harmless and leaves the portfolio value one edit from being
-- wiped, with this test still green.
INSERT INTO public.fmv_snapshots (edition_id, fmv_usd, computed_at)
VALUES ('11111111-1111-1111-1111-111111111111', NULL, now());
DELETE FROM public.rwfc_state;
SELECT _assert_eq(public.refresh_wmc_fmv_changed()::text, '0',
  'a NULL-priced snapshot does not even enter the queue, so nothing is rewritten');
SELECT _assert_eq(
  (SELECT fmv_usd::text FROM public.wallet_moments_cache WHERE wallet_address='0xB'), '250.00',
  'and the existing price is untouched');

-- ── The cursor advances, so the next tick does not re-scan ────────────────
-- rwfc_state is what makes this incremental. If it stopped advancing the sweep
-- would re-read the same window forever — which on this function means re-doing
-- the largest disk read on the instance every ten minutes.
SELECT _assert(
  (SELECT last_cutoff FROM public.rwfc_state WHERE id = 1) IS NOT NULL,
  'the cursor is persisted after a run');
SELECT _assert(
  (SELECT last_cutoff FROM public.rwfc_state WHERE id = 1) > now() - interval '1 minute',
  'a fully-drained queue advances the cursor to the run start, not backwards');

SELECT '✓ refresh_wmc_fmv_changed invariants pass' AS result;
ROLLBACK;

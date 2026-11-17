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

-- ⚠ RE-PINNED 2026-11-14 (#248) onto supabase/migrations/20261114171317_audit_20261114_rwfc_drops_only_what_it_applied.sql.
-- Three premises changed, so three assertions were RE-PINNED (not inverted) and three ADDED:
--   * the 08-30 drop rule now compares against rwfc_applied (what this lane last pushed),
--     not the newest pre-cursor snapshot, which purge_fmv_snapshots_today can erase;
--     the "dropped" assertion keeps its stale-row proof, with the applied row as premise;
--   * confidence travels with the price (churn guard is now price OR confidence);
--   * the cursor stops 5 minutes behind the run start (commit-time race), so the
--     "advances to the run start" assertion becomes "to run start minus the overlap".
--   Added: the PURGE case (an intraday price erased from history must not hide a move
--   back), a confidence-only move, and a late-committed snapshot inside the overlap.
--   Each added case was proven red against the 08-30 body (planted defects, 11-14).

BEGIN;

CREATE TYPE public.fmv_confidence AS ENUM ('HIGH', 'MEDIUM', 'LOW', 'ASK_ONLY', 'SALES_ONLY', 'STALE', 'NO_DATA');

CREATE TABLE public.editions (
  id            uuid primary key,
  collection_id uuid,
  external_id   text
);

CREATE TABLE public.fmv_snapshots (
  edition_id  uuid,
  fmv_usd     numeric,
  confidence  public.fmv_confidence,
  computed_at timestamptz
);

CREATE TABLE public.wallet_moments_cache (
  id             bigserial primary key,
  wallet_address text,
  collection_id  uuid,
  edition_key    text,
  fmv_usd        numeric,
  fmv_confidence public.fmv_confidence
);

CREATE TABLE public.rwfc_state (
  id          int primary key,
  last_cutoff timestamptz
);

CREATE TABLE public.rwfc_applied (
  edition_id uuid PRIMARY KEY,
  fmv_usd    numeric NOT NULL,
  confidence public.fmv_confidence,
  applied_at timestamptz NOT NULL DEFAULT now()
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
  -- 2026-11-14 (#248): how far behind its run start the cursor stops. fmv-recalc stamps
  -- snapshots with its transaction start and commits ~50 s later; a tick inside that
  -- window must not advance past a batch it could not yet see.
  v_overlap    constant interval := interval '5 minutes';
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

  -- 2026-08-30: drop editions whose newest price is the price wmc already has --
  -- fmv-recalc writes a row per recalculated edition whether or not the number moved
  -- (74 % of snapshots), and without this every one of them read every holder row.
  -- 2026-11-14 (#248): "the price wmc already has" is now the (fmv_usd, confidence)
  -- this lane last APPLIED (rwfc_applied), NOT the newest snapshot at or before the
  -- cursor. fmv-recalc purges an edition's earlier same-day snapshot before inserting
  -- the next, so after an intraday move the pre-cursor snapshot is the DAY-BEFORE
  -- price: a move back to it was dropped as "unchanged" and the holder rows kept the
  -- erased intraday price for 6–8 h (72 % of the lane's measured misses). An edition
  -- with no rwfc_applied row has nothing to compare against and stays queued.
  DELETE FROM _rwfc_recent
   WHERE edition_id IN (
     SELECT r.edition_id
       FROM _rwfc_recent r
       JOIN LATERAL (
         SELECT f.fmv_usd, f.confidence FROM public.fmv_snapshots f
          WHERE f.edition_id = r.edition_id AND f.computed_at > v_cutoff AND f.fmv_usd IS NOT NULL
          ORDER BY f.computed_at DESC LIMIT 1
       ) cur ON true
       JOIN public.rwfc_applied a ON a.edition_id = r.edition_id
      WHERE cur.fmv_usd = a.fmv_usd
        AND cur.confidence IS NOT DISTINCT FROM a.confidence
   );

  LOOP
    WITH popped AS (
      DELETE FROM _rwfc_recent
       WHERE edition_id IN (
         SELECT edition_id FROM _rwfc_recent ORDER BY computed_at LIMIT v_chunk
       )
      RETURNING edition_id
    ),
    latest_fmv AS MATERIALIZED (
      SELECT e.id AS edition_id, e.collection_id, e.external_id, s.fmv_usd, s.confidence
      FROM popped p
      JOIN public.editions e ON e.id = p.edition_id
      LEFT JOIN LATERAL (
        SELECT f.fmv_usd, f.confidence
          FROM public.fmv_snapshots f
         WHERE f.edition_id = e.id
           AND f.fmv_usd IS NOT NULL
         ORDER BY f.computed_at DESC
         LIMIT 1
      ) s ON true
    ),
    updated AS (
      UPDATE public.wallet_moments_cache wmc
         SET fmv_usd = lf.fmv_usd,
             fmv_confidence = lf.confidence
        FROM latest_fmv lf
       WHERE wmc.collection_id = lf.collection_id
         AND wmc.edition_key   = lf.external_id
         AND wmc.edition_key IS NOT NULL
         AND lf.fmv_usd IS NOT NULL
         AND (wmc.fmv_usd IS DISTINCT FROM lf.fmv_usd
              OR wmc.fmv_confidence IS DISTINCT FROM lf.confidence)
      RETURNING 1
    ),
    -- 2026-11-14 (#248): remember what was pushed, in the same statement as the push,
    -- so the record and the wmc write commit (or roll back) together.
    recorded AS (
      INSERT INTO public.rwfc_applied (edition_id, fmv_usd, confidence, applied_at)
      SELECT lf.edition_id, lf.fmv_usd, lf.confidence, now()
        FROM latest_fmv lf
       WHERE lf.fmv_usd IS NOT NULL
      ON CONFLICT (edition_id) DO UPDATE
        SET fmv_usd = EXCLUDED.fmv_usd, confidence = EXCLUDED.confidence, applied_at = EXCLUDED.applied_at
      RETURNING 1
    )
    SELECT COUNT(*)::int INTO v_batch FROM updated;

    v_total := v_total + COALESCE(v_batch, 0);

    EXIT WHEN NOT EXISTS (SELECT 1 FROM _rwfc_recent);
    EXIT WHEN clock_timestamp() > v_deadline;
    EXIT WHEN v_total >= p_limit;
  END LOOP;

  SELECT MIN(computed_at) - interval '1 microsecond' INTO v_new_cutoff FROM _rwfc_recent;
  -- 2026-11-14 (#248): never further forward than v_overlap behind this run's start.
  v_new_cutoff := LEAST(COALESCE(v_new_cutoff, v_run_start), v_run_start - v_overlap);

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
INSERT INTO public.fmv_snapshots (edition_id, fmv_usd, confidence, computed_at) VALUES
  ('11111111-1111-1111-1111-111111111111', 100.00, 'LOW',  now() - interval '5 minutes'),
  ('11111111-1111-1111-1111-111111111111', 250.00, 'LOW',  now() - interval '1 minute'),
  ('22222222-2222-2222-2222-222222222222',  42.00, 'HIGH', now() - interval '2 minutes'),
  ('33333333-3333-3333-3333-333333333333', 999.00, 'LOW',  now() - interval '2 minutes');

INSERT INTO public.wallet_moments_cache (wallet_address, collection_id, edition_key, fmv_usd, fmv_confidence) VALUES
  ('0xA', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '48:1652',  NULL,   NULL),   -- never priced
  ('0xB', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '48:1652',  100.00, 'LOW'),  -- stale price
  ('0xC', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '121:4255', 42.00,  'HIGH'), -- ALREADY correct
  ('0xD', 'dee28451-5d62-409e-a1ad-a83f763ac070', '48:1652',  NULL,   NULL),   -- other collection
  ('0xE', '95f28a17-224a-4025-96ad-adf8a4c63bfd', NULL,       NULL,   NULL);   -- unkeyed row

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

-- ── 2026-08-30: an edition whose price did not move is not re-swept ───────
-- RE-PINNED 2026-11-14: the premise is now the APPLIED row, not the pre-cursor
-- snapshot. The first run above pushed edition 2 at (42.00, HIGH) and recorded it in
-- rwfc_applied; its new snapshot (42.00, HIGH) equals that, so the drain drops it
-- before the loop instead of reading every holder row to discover IS DISTINCT FROM
-- has nothing to write.
-- Pinned through a deliberately stale holder row: because the edition is
-- skipped, the row is NOT repaired here (that is the NULL-fill route's job and
-- would otherwise cost a holder scan for three editions in four).
INSERT INTO public.rwfc_state (id, last_cutoff) VALUES (1, now() - interval '90 seconds')
ON CONFLICT (id) DO UPDATE SET last_cutoff = EXCLUDED.last_cutoff;
SELECT _assert_eq(
  (SELECT fmv_usd::text || ' ' || confidence::text FROM public.rwfc_applied
    WHERE edition_id = '22222222-2222-2222-2222-222222222222'), '42.00 HIGH',
  'a processed edition records the (price, confidence) it pushed');
INSERT INTO public.fmv_snapshots (edition_id, fmv_usd, confidence, computed_at)
VALUES ('22222222-2222-2222-2222-222222222222', 42.00, 'HIGH', now() - interval '30 seconds');
UPDATE public.wallet_moments_cache SET fmv_usd = 5.00 WHERE wallet_address = '0xC';
SELECT _assert_eq(public.refresh_wmc_fmv_changed()::text, '0',
  'an edition whose newest (price, confidence) equals what this lane last applied is dropped from the queue');
SELECT _assert_eq(
  (SELECT fmv_usd::text FROM public.wallet_moments_cache WHERE wallet_address='0xC'), '5.00',
  'so its holder rows are not even read (the stale row proves the skip happened)');
UPDATE public.wallet_moments_cache SET fmv_usd = 42.00 WHERE wallet_address = '0xC';

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
INSERT INTO public.fmv_snapshots (edition_id, fmv_usd, confidence, computed_at)
VALUES ('11111111-1111-1111-1111-111111111111', NULL, NULL, now());
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
-- RE-PINNED 2026-11-14: the cursor now stops v_overlap (5 min) behind the run start,
-- so a batch stamped before a tick and committed after it is re-read next tick.
SELECT _assert(
  (SELECT last_cutoff FROM public.rwfc_state WHERE id = 1) > now() - interval '6 minutes',
  'a fully-drained queue advances the cursor, not backwards');
SELECT _assert(
  (SELECT last_cutoff FROM public.rwfc_state WHERE id = 1) <= clock_timestamp() - interval '5 minutes',
  'and stops the overlap behind the run start, never at it');

-- ── 2026-11-14 (#248): THE PURGE CASE ─────────────────────────────────────
-- fmv-recalc purges an edition's earlier same-day snapshot before inserting the next.
-- Edition 1 sat at 250.00 LOW; an intraday 300.00 MEDIUM reached wmc; the next recalc
-- PURGED that snapshot and wrote 250.00 LOW again. The surviving pre-cursor snapshot is
-- 250.00 LOW — equal to the new one — so the 08-30 rule dropped the edition and the
-- holders kept the erased 300.00 for 6–8 h. Compared to what was APPLIED (300.00), the
-- move back is a move.
INSERT INTO public.fmv_snapshots (edition_id, fmv_usd, confidence, computed_at)
VALUES ('11111111-1111-1111-1111-111111111111', 300.00, 'MEDIUM', clock_timestamp());
DELETE FROM public.rwfc_state;
SELECT _assert_eq(public.refresh_wmc_fmv_changed()::text, '2',
  'the intraday price reaches both Top Shot holders');
DELETE FROM public.fmv_snapshots
 WHERE edition_id = '11111111-1111-1111-1111-111111111111' AND fmv_usd = 300.00;   -- the purge
INSERT INTO public.fmv_snapshots (edition_id, fmv_usd, confidence, computed_at)
VALUES ('11111111-1111-1111-1111-111111111111', 250.00, 'LOW', clock_timestamp());
UPDATE public.rwfc_state SET last_cutoff = clock_timestamp() - interval '1 minute';
SELECT _assert_eq(public.refresh_wmc_fmv_changed()::text, '2',
  'a move BACK to a price the purge left as the pre-cursor snapshot is still a move');
SELECT _assert_eq(
  (SELECT string_agg(fmv_usd::text || ' ' || fmv_confidence::text, ',' ORDER BY wallet_address)
     FROM public.wallet_moments_cache WHERE wallet_address IN ('0xA', '0xB')), '250.00 LOW,250.00 LOW',
  'so no holder keeps the erased intraday price');

-- ── 2026-11-14 (#248): a confidence-only move propagates ──────────────────
INSERT INTO public.fmv_snapshots (edition_id, fmv_usd, confidence, computed_at)
VALUES ('22222222-2222-2222-2222-222222222222', 42.00, 'MEDIUM', clock_timestamp());
UPDATE public.rwfc_state SET last_cutoff = clock_timestamp() - interval '1 minute';
SELECT _assert_eq(public.refresh_wmc_fmv_changed()::text, '1',
  'a same-price snapshot with a new confidence is not dropped');
SELECT _assert_eq(
  (SELECT fmv_usd::text || ' ' || fmv_confidence::text FROM public.wallet_moments_cache WHERE wallet_address = '0xC'),
  '42.00 MEDIUM', 'and the holder takes the new confidence with an unchanged price');

-- ── 2026-11-14 (#248): a snapshot committed behind the cursor is not lost ─
-- fmv-recalc stamps its rows with its transaction start and commits ~50 s later. A
-- tick that ran in between could not see them; its cursor must not pass them.
SELECT public.refresh_wmc_fmv_changed();   -- an empty tick: the cursor moves up
INSERT INTO public.fmv_snapshots (edition_id, fmv_usd, confidence, computed_at)
VALUES ('33333333-3333-3333-3333-333333333333', 1111.00, 'LOW', clock_timestamp() - interval '90 seconds');
SELECT _assert_eq(public.refresh_wmc_fmv_changed()::text, '1',
  'a snapshot stamped before the last tick but committed after it is still applied');
SELECT _assert_eq(
  (SELECT fmv_usd::text FROM public.wallet_moments_cache WHERE wallet_address = '0xD'), '1111.00',
  'on the All Day holder it belongs to');

SELECT '✓ refresh_wmc_fmv_changed invariants pass' AS result;
ROLLBACK;

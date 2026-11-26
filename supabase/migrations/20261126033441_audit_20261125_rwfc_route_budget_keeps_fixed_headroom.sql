-- audit_20261125_rwfc_route_budget_keeps_fixed_headroom
--
-- refresh_wmc_fmv_changed sizes its loop deadline at 60 % of the caller's statement_timeout
-- and checks it only BETWEEN chunks. Under the wmc-fmv-populate route (PostgREST,
-- service_role 30 s) that is an 18 s deadline with 12 s of headroom, but one 5-edition chunk
-- can wait up to 8 s on wallet_moments_cache row locks (authenticator lock_timeout = 8 s)
-- before doing its own work. Measured 2026-11-25 (pipeline_runs, 48 h): successful route
-- runs reach 20-28 s every hour, and 5 runs between 8:53 AM and 7:08 PM PT died at
-- exactly 30 s with `canceling statement due to statement timeout` (none before 11-24).
-- A killed tick rolls back its wmc writes AND the cursor, so the work is redone later; the
-- cost is ~30 s of wasted IO per kill and a red pipeline_runs row.
--
-- Change: budget = GREATEST(LEAST(60 % of timeout, timeout - 20 s), 5 s).
--   service_role 30 s  -> 10 s (was 18 s): 20 s of headroom for one chunk's overshoot.
--   cron_heavy 600 s   -> 360 s (unchanged): jobid 303 keeps its full drain capacity.
--   unset / 0          -> 300 s (unchanged branch).
-- Capacity: rwfc_state lag 7 min at write time (= the 5-min overlap floor + one tick);
-- jobid 303 p50 0.4 s over 144 runs/24 h, so the backlog has ample slack for a shorter
-- route tick. Nothing else in the body changes.
--
-- Verify (owed ~11-26 evening): pipeline_runs where pipeline='refresh_wmc_fmv_changed' and
-- error ilike '%statement timeout%' since this apply -> 0 (was 5 / 11 h); max duration_ms
-- of ok runs < ~25 s; rwfc_state lag stays < ~20 min.
-- Revert: re-apply the function from
-- supabase/migrations/20261114171317_audit_20261114_rwfc_drops_only_what_it_applied.sql
-- (CREATE OR REPLACE only; do not re-run its table/seed statements).
-- anon-exec: unchanged (refresh_wmc_fmv_changed) — CREATE OR REPLACE of an existing fn; ACL preserved.

DO $guard$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.refresh_wmc_fmv_changed(integer,integer)'::regprocedure)
     IS DISTINCT FROM 'fc41b0b8c2d75806f1bf6905e01e192c' THEN
    RAISE EXCEPTION 'refresh_wmc_fmv_changed changed since this migration was written — re-read the live body';
  END IF;
END
$guard$;

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
  -- and app/api/wmc-fmv-populate/route.ts (every 5 min, ~10 s budget). The route's tick one
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
    -- 2026-11-25: 40 % headroom alone is 12 s under the route's 30 s service_role cap, and
    -- one chunk can wait 8 s on wmc row locks (authenticator lock_timeout) on top of its own
    -- work: successful route runs reached 20-28 s against the 18 s deadline, and 5 of them
    -- in 11 h overshot to the 30 s kill (57014, the whole tick rolled back). Keep a FIXED
    -- 20 s as well: 30 s -> 10 s budget; 600 s (cron_heavy, jobid 303) -> 360 s, unchanged.
    v_budget := GREATEST(LEAST(make_interval(secs => (v_timeout_ms / 1000.0) * 0.6),
                               make_interval(secs => (v_timeout_ms / 1000.0) - 20)),
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

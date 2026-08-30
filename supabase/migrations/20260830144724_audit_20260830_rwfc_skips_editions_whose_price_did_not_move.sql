-- audit_20260830: refresh_wmc_fmv_changed scans every holder row of editions
-- whose price did not move.
--
-- jobid 303 (`7-57/10`, cron_heavy) is this function; it hit its 360 s budget on
-- every tick today (361–433 s, 144 runs/24 h, ~60 % of wall-clock, the largest
-- single pg_cron consumer per the 08-30 ledger) and sat ~50 min behind
-- (rwfc_state.last_cutoff 13:48Z at 14:38Z, 2,626 editions queued). The queue
-- is "every edition with a new priced snapshot", and fmv-recalc writes a
-- snapshot per recalculated edition whether or not the value changed:
-- 2,295 of 3,108 snapshots in the 2 h to 14:40Z (74 %) equal the edition's
-- previous snapshot exactly (2,323 within 0.5 %). For each of those the loop
-- still ran the UPDATE, whose IS DISTINCT FROM guard writes nothing but must
-- read every holder row to know that — the drain's entire IO cost, on the
-- bloated idx_wmc_coll_ek_serial_cover (498 MB @ 28 % leaf density).
--
-- The holder-weighted split could not be measured: a 20-minute sample of
-- per-edition holder counts did not finish inside 55 s on the saturated
-- instance, which is the same scan this change removes.
--
-- CHANGE: after _rwfc_recent is built, delete editions whose newest priced
-- snapshot after the cursor equals their newest priced snapshot at or before
-- the cursor. Two index probes per queued edition on fmv_snapshots
-- (edition_id, computed_at) replace the holder scan. Sound because the cursor
-- only advances past an edition once its UPDATE committed, so wmc already
-- carries the <= cursor value; an edition with no prior priced snapshot is
-- not skipped. The loop, chunking, budget, advisory lock, cursor arithmetic
-- and the three NULL guards are untouched.
--
-- Not the 08-26 fast path (reverted 08-28 for +18 % reads/call): that changed
-- WHAT the update read; this changes WHETHER an edition is read at all, and
-- removes reads rather than trading them.
--
-- Pinned: supabase/tests/refresh_wmc_fmv_changed.sql (verbatim copy + a new
-- case: an unchanged-price edition is not re-swept) and
-- __tests__/db-invariants-drift-guard.test.ts (re-pointed).
--
-- anon-exec: refresh_wmc_fmv_changed — unchanged; no GRANT/REVOKE here.
--
-- Exit (48 h): jobid 303 mean duration falls well below its 360 s budget and
-- rwfc_state.last_cutoff lag drops toward the 10-min tick. Falsifier: runs
-- still pin at 360 s -> the changed editions alone saturate the budget and the
-- next lever is the (collection_id, edition_key) index rebuild.
-- Revert: re-apply the body from 20260829030000_audit_20260828_rwfc_two_callers_collide_every_ten_minutes.sql.

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

  -- 2026-08-30: drop editions whose newest price is the price they already had.
  -- Measured over a 2 h window: 2,295 of 3,108 new snapshots (74 %) carried an
  -- fmv_usd IDENTICAL to the edition's previous snapshot — fmv-recalc writes a
  -- row per recalculated edition whether or not the number moved. Every one of
  -- those editions was still popped below, and the UPDATE's IS DISTINCT FROM
  -- guard, which correctly writes nothing, still READS every holder row to find
  -- that out: on a 2.5M-row table behind a bloated (collection_id, edition_key)
  -- index that is the drain's IO, and this job (303, `7-57/10`) ran to its 360 s
  -- deadline on every tick, ~60 % of wall-clock, ~50 min behind. Two index
  -- probes per queued edition replace a holder scan for three editions in four.
  -- Sound because wmc already holds the <= v_cutoff value: the cursor only
  -- advances past an edition once its UPDATE committed (a timeout rolls both
  -- back together). An edition with no priced snapshot on or before the cutoff
  -- has nothing to compare against and stays queued.
  DELETE FROM _rwfc_recent
   WHERE edition_id IN (
     SELECT r.edition_id
       FROM _rwfc_recent r
       JOIN LATERAL (
         SELECT f.fmv_usd FROM public.fmv_snapshots f
          WHERE f.edition_id = r.edition_id AND f.computed_at > v_cutoff AND f.fmv_usd IS NOT NULL
          ORDER BY f.computed_at DESC LIMIT 1
       ) cur ON true
       JOIN LATERAL (
         SELECT f.fmv_usd FROM public.fmv_snapshots f
          WHERE f.edition_id = r.edition_id AND f.computed_at <= v_cutoff AND f.fmv_usd IS NOT NULL
          ORDER BY f.computed_at DESC LIMIT 1
       ) prev ON true
      WHERE cur.fmv_usd = prev.fmv_usd
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

-- audit_20261115_rwfc_revert_to_0830_body_cost_bar
--
-- STAGED 2026-11-15 ~12:40 PM PT by Claude Code cloud (scheduled #248 watch); apply_migration raised the
-- destructive-statement question and nobody was there to answer, so NOTHING IS APPLIED. REVERTS 20261114171317
-- (refresh_wmc_fmv_changed drops only what it applied + confidence + 5-min cursor overlap) to the
-- 08-30 body, and puts its backstop (job 617) back on its 2-hourly schedule.
--
-- WHY: 20261114171317 shipped with a PRE-REGISTERED cost bar — reads/call on the two pinned queryids
-- must stay under the 08-28 bar (74,159 pg_cron / 7,195 PostgREST), else re-apply 20260830144724.
-- pg_stat_statements deltas, service_role -2064728835023368966 (PostgREST, every 5 min):
--   1 h windows: 8:49 -> 9:50 AM PT 5,907 · 9:33 -> 10:34 12,324 · 10:43 -> 11:43 6,979 · 11:43 -> 12:34 9,062
--   POOLED 9:33:33 -> 12:34:30 AM/PM PT (3 h, 36 calls): 9,146 reads/call (+27 % over the bar),
--     77,603 buffers/call vs 36,901 pre-apply (2.1x blocks touched).
--   pooled 23 h after the apply: 8,266 reads/call.
-- Read share of buffers was ~12 % in every window and pre-apply, so the excess is WORK, not a cold cache.
-- 1 h windows swing ~2x on a few heavy ticks; every window >= 2 h is over the bar. cron_heavy stayed under
-- its bar (3 h pooled 8,869 reads/call).
-- What this gives back: fast-lane miss 0.8 % of rows before the fix -> 0.11-0.15 % after. Most of the
-- remaining misses were job 446 (reconcile_saved_wallets_wmc_fmv) writing a stale edition_fmv_current
-- price over the lane — a separate defect, not touched here (#248).
--
-- JOB 617: 20261115175130 moved rpc-wmc-fmv-stuck-resync to daily on the strength of this fix. With the
-- fix reverted, the misses it heals come back at ~0.8 %, and 617 was still fixing ~7,040 rows per run, so
-- it returns to '33 */2 * * *' and its watchlist row to 183/366 min (the exact REVERT block of 20261115175130).
--
-- REVERT OF THIS REVERT: re-apply supabase/migrations/20261114171317_audit_20261114_rwfc_drops_only_what_it_applied.sql
-- (its md5 guard expects the 08-30 body installed here), then 20261115175130 (its guard expects the 2-hourly job).
-- rwfc_applied is left in place, unread by the 08-30 body.
-- anon-exec: refresh_wmc_fmv_changed — unchanged; CREATE OR REPLACE preserves the ACL.

DO $guard$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.refresh_wmc_fmv_changed(integer,integer)'::regprocedure)
     IS DISTINCT FROM 'fc41b0b8c2d75806f1bf6905e01e192c' THEN
    RAISE EXCEPTION 'refresh_wmc_fmv_changed changed since this migration was written — re-read the live body';
  END IF;
END
$guard$;

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

DO $$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.refresh_wmc_fmv_changed(integer,integer)'::regprocedure)
     IS DISTINCT FROM '80f0461843d1b5105a0a3aed193eeb9d' THEN
    RAISE EXCEPTION 'refresh_wmc_fmv_changed: installed body is not the 08-30 body';
  END IF;
END $$;

DO $$
DECLARE v_n int; v_id bigint;
BEGIN
  SELECT count(*), max(jobid) INTO v_n, v_id FROM cron.job
   WHERE jobname = 'rpc-wmc-fmv-stuck-resync' AND username = 'cron_heavy' AND schedule = '33 12 * * *'
     AND command = 'SELECT public.resync_stuck_wmc_fmv();';
  IF v_n <> 1 THEN RAISE EXCEPTION 'rpc-wmc-fmv-stuck-resync: expected the daily 12:33 UTC cron_heavy job, found % match(es)', v_n; END IF;
  SET LOCAL ROLE cron_heavy;
  PERFORM cron.schedule('rpc-wmc-fmv-stuck-resync', '33 */2 * * *', 'SELECT public.resync_stuck_wmc_fmv();');
  RESET ROLE;
  IF (SELECT count(*) FROM cron.job WHERE jobname = 'rpc-wmc-fmv-stuck-resync') <> 1
     OR (SELECT jobid FROM cron.job WHERE jobname = 'rpc-wmc-fmv-stuck-resync') <> v_id
     OR (SELECT schedule FROM cron.job WHERE jobname = 'rpc-wmc-fmv-stuck-resync' AND username = 'cron_heavy' AND active) <> '33 */2 * * *' THEN
    RAISE EXCEPTION 'rpc-wmc-fmv-stuck-resync: not re-timed in place (same jobid, cron_heavy, active)';
  END IF;

  UPDATE public.pipeline_cadence_watchlist
     SET max_silent_minutes = 183, max_minutes_without_success = 366,
         notes = notes || ' | 2026-11-15 PM: #248 fast-lane fix reverted on its cost bar -> job 617 back to 2-hourly, 183/366.'
   WHERE pipeline = 'wmc-fmv-stuck-resync' AND max_silent_minutes = 1560;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN RAISE EXCEPTION 'wmc-fmv-stuck-resync watchlist: expected 1 row at 1560 min, updated %', v_n; END IF;
END $$;

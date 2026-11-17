-- audit_20260828_rwfc_two_callers_collide_every_ten_minutes
--
-- 🚨 `refresh_wmc_fmv_changed` HAS TWO CALLERS THAT RUN THE SAME NON-REENTRANT DRAIN, AND ONE
-- OF THEM HOLDS `wallet_moments_cache` ROW LOCKS FOR FOUR MINUTES AT A TIME.
--   · pg_cron jobid 303 `rpc-refresh-wmc-fmv-changed`, schedule `7-57/10` -> :07 :17 :27 :37 :47 :57
--   · app/api/wmc-fmv-populate/route.ts, cron-job.org, every 5 min -> :03 :08 :13 :18 :23 ...
-- Measured from `cron.job_run_details` (48 h, n=284 succeeded): jobid 303 runs a MEDIAN of
-- **240.8 s**, mean 210.6 s, max **463.4 s**. So it is still draining when the route's tick one
-- minute later calls the same function, and that tick blocks and dies on `lock_timeout`.
--
-- ── THE SIGNAL IS EXACT, AND IT IS A MINUTE-LEVEL PATTERN ───────────────────
-- `refresh_wmc_fmv_changed` runs in `pipeline_runs` over 48 h, by MINUTE:
--   :58  28 lock timeouts / 47 runs   (59.6%)      :03   0 / 42
--   :38  27 / 45                      (60.0%)      :13   0 / 46
--   :18  22 / 45                      (48.9%)      :23   0 / 44
--   :28   7 / 43                      (16.3%)      :33   1 / 46
--   :08   5 / 45                      (11.1%)      :43   0 / 43
--   :48   5 / 45                      (11.1%)      :53   0 / 45
-- ⭐ Every odd-decade minute (:08 :18 :28 :38 :48 :58) is one minute after a jobid-303 firing.
-- Every even-decade minute (:03 :13 :23 :33 :43 :53) is clean. **83 of 84 lock timeouts land on
-- the six minutes that follow jobid 303.**
--
-- ⚠ THIS IS WHY THE OBVIOUS HYPOTHESIS FAILED. Earlier tonight I tested "the wallet-backfill
-- waves are fighting the refreshers" and the hourly distribution refuted it flat (11 of 51 in
-- the four wave hours; 40 in the twenty hours with ZERO backfill runs). It looked uniform
-- because it IS uniform across hours -- the collision is on the MINUTE hand, and an hourly
-- histogram cannot see it. Pick the bucket that matches the suspected period.
--
-- ── WHY THE TWO CALLERS ARE SO ASYMMETRIC ───────────────────────────────────
-- The function derives its own loop budget from `pg_settings.statement_timeout` x 0.6. Over
-- PostgREST as service_role that is 30 s -> an ~18 s budget. Under pg_cron the setting is unset,
-- so the function's own `ELSE` branch gives it **interval '300 seconds'**. The 300 s caller
-- therefore starves the 18 s caller by construction, every ten minutes, forever.
--
-- ⛔ SHIFTING THE SCHEDULE CANNOT FIX THIS and was rejected on the numbers: jobid 303 occupies
-- ~4 minutes of every 10, and the route ticks every 5, so exactly one route tick lands inside
-- that window at ANY offset. The observed ~50% (three bad minutes of six) is the structural rate.
--
-- ── THE FIX: MAKE THE COLLISION A SKIP INSTEAD OF A FAILURE ─────────────────
-- `pg_try_advisory_xact_lock` at the top. If another instance is already draining, return NULL
-- immediately rather than blocking ~18 s and dying. No work is lost -- the other caller is
-- draining the same `rwfc_state` cursor, which is the whole point of the resumable design.
--
-- ⚠ `_xact_` IS LOAD-BEARING AND A SESSION-LEVEL LOCK WOULD BE A BUG HERE. Supabase pools
-- connections, so a session-level `pg_advisory_lock` leaked by any path would be inherited by an
-- unrelated later request and would wedge this function permanently. A transaction-scoped lock
-- is released by COMMIT or ROLLBACK on every path, including a `statement_timeout` kill, so it
-- cannot leak. (House style for the key follows `award_points` / `redeem_shop_item`, which
-- already use `pg_advisory_xact_lock(hashtext(...))`.)
--
-- 🚨 NULL, NOT 0, AND THE REASON IS THE HONESTY CANON. `rows_written = 0` on this pipeline
-- already carries three incompatible meanings (CLAUDE.md, DB section); "another instance is
-- doing it" must not become a fourth. NULL is returned so the caller can tell a skip from a
-- drained-nothing, and app/api/wmc-fmv-populate/route.ts is changed IN THE SAME PUSH to record
-- it as `ok = true`, `rows_* = NULL`, `extra.note = 'skipped_concurrent_refresh'`.
-- ⛔ Do NOT "simplify" this to `RETURN 0` -- `Number(null ?? 0) || 0` in the route makes the two
-- indistinguishable again, which is exactly the defect class this repo counts.
--
-- ⚠ The return TYPE is unchanged (`integer`), so no caller signature changes and pg_cron's
-- `SELECT public.refresh_wmc_fmv_changed(30, 200000)` keeps working -- it discards the value.
--
-- ⚠ Parameter defaults (`p_since_minutes DEFAULT 30, p_limit DEFAULT 50000`), SECURITY DEFINER
-- and `SET search_path = public, pg_temp` are restated verbatim, re-read from
-- `pg_get_function_arguments` rather than remembered: CREATE OR REPLACE drops proconfig silently
-- and refuses to drop defaults loudly (42P13).
-- anon-exec: unchanged (refresh_wmc_fmv_changed) -- CREATE OR REPLACE does not touch the ACL;
-- verified anon=false, authenticated=false, service_role=true before and after.
--
-- REVERT: re-create the function without the `pg_try_advisory_xact_lock` guard (delete the
-- IF block at the top of BEGIN). Nothing else differs, and no data is written or destroyed.
--
-- EXIT CONDITION: `canceling statement due to lock timeout` on `refresh_wmc_fmv_changed` falls
-- from 84 in 48 h (51 in 24 h) toward 0, replaced by `skipped_concurrent_refresh` notes on
-- roughly the same minutes.
-- FALSIFIER: if lock timeouts persist on :08/:18/:28/:38/:48/:58 after this, the blocker is NOT
-- another instance of this function -- look at pg_cron jobid 302
-- (`backfill_wmc_fmv_confidence`, `2-59/5`), which also writes `wallet_moments_cache` and fires
-- at :07 alongside 303.

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

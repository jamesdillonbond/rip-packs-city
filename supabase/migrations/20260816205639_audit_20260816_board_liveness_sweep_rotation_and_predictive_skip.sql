-- audit_20260816_board_liveness_sweep_rotation_and_predictive_skip
--
-- ⚠ SUPERSEDED IN PART, MINUTES LATER, BY
--   20260816210146_audit_20260816_board_liveness_sweep_skip_estimator_p90_to_p50.sql
-- The ROTATION half of this migration is correct and still live. The predictive-skip
-- ESTIMATOR shipped here (p90) was wrong and is corrected in that follow-up. Both rows
-- exist in prod's supabase_migrations.schema_migrations; both files are kept so a replay
-- reproduces the recorded history. If you only want the end state, read the p50 file.
--
-- WHY -------------------------------------------------------------------------
-- public_board_empty_count and public_board_slow_count have both been reading
-- 999 (the INCONCLUSIVE sentinel), which the Sentinel board renders as two
-- BREACH arms. They are NOT 999 real bad boards: public_board_liveness_probe()
-- returns budget_exhausted=true because the sweep cannot finish, and
-- rpc_thp_leg_board_liveness maps that to 999 by design.
--
-- MEASURED 2026-08-16 (PT afternoon), cron job 288:
--   * 18:28Z tick: candy_parallel_premium alone took 685,492 ms. Its own 10-day
--     range is 1,251-96,043 ms, so this was a ~7x outlier on its worst prior day
--     and ~500x its median. The 600 s soft budget is only checked BETWEEN boards,
--     so it was blown after board 6 of 45. probed=6, budget_exhausted=true.
--   * 12:32Z tick, and the 2026-08-15 18:28Z tick: the 900 s HARD statement_timeout
--     on job 288 cancelled the statement mid-board (candy_scarcity_board and
--     panini_squeeze_board). pg_cron status 'failed'; because the whole sweep is
--     one transaction, ALL boards probed that cycle were rolled back.
--   * The loop was ORDER BY view_name and never rotated, so the boards dropped
--     were ALWAYS the same alphabetical tail. 39 of 45 had gone unprobed for
--     14.4 h at the time of diagnosis.
--
-- WHAT WAS TRIED AND REJECTED -------------------------------------------------
-- A per-board statement_timeout would be the textbook fix. It does not work here
-- and this was verified empirically, not assumed:
--   * set_config('statement_timeout', ..., true) inside a plpgsql block does NOT
--     cancel a statement running inside that same block -- tested with pg_sleep(6)
--     under a 2 s local timeout: "NO TIMEOUT FIRED", elapsed 6,012 ms.
--   * COMMIT inside a PROCEDURE does not re-arm it either -- same probe as a
--     procedure with COMMIT before the SET: "NO TIMEOUT FIRED", elapsed 6,004 ms.
-- The timer is armed once, at the start of the top-level statement. Real
-- preemption would need a separate session (dblink is available but NOT
-- installed); opening 45 sessions on an instance that is already failing
-- allday-buyer-backfill on "Timed out acquiring connection from connection pool"
-- would be actively harmful. Rejected with cause.
--
-- THE FIX (both changes confined to this function; signature UNCHANGED, so no new
-- overload is created and the existing {postgres=X,service_role=X} ACL is kept) --
--   1. ROTATION. Least-recently-probed first (checked_at NULLS FIRST). When the
--      budget does bind, coverage now moves on instead of starving the same tail.
--      A board that eats a whole sweep is the FRESHEST next cycle, so the other 44
--      go first -- the exact inverse of the observed failure.
--   2. PREDICTIVE SKIP. Board cost is estimated from its own p90 elapsed_ms over
--      14 days of public_board_liveness_history (fallback: max_ms * 2). From the
--      second board onward, a board is not STARTED unless its estimate fits in the
--      remaining budget. This is the only preemption available without a second
--      session: we cannot stop a board, so we decline to begin one that cannot
--      finish. The first board in rotation order is always probed, which
--      guarantees forward progress on even the most pathological view.
--      ⚠ THE p90 CHOICE ON THIS LINE IS THE DEFECT CORRECTED BY THE FOLLOW-UP.
--
-- HONEST LIMIT: this makes the 900 s total-loss much less likely, it does not make
-- it impossible. candy_parallel_premium's 685 s run exceeded its own p90 by ~7x,
-- and no estimator catches that. What it does guarantee is that such a run costs
-- ONE cycle of that one board rather than permanently starving 39 others.
--
-- NOT CHANGED: cron job 288 (schedule, 900 s statement_timeout, 600000 argument),
-- public_board_liveness_watchlist, public_board_liveness_probe() including its
-- 480-minute freshness window, and rpc_thp_leg_board_liveness().
--
-- REVERT ----------------------------------------------------------------------
--   Re-apply the immediately-prior definition of
--   public.public_board_liveness_sweep(integer). Relative to this version the
--   three edits to undo are: (a) drop the est/p90 CTE and the LEFT JOINs from the
--   FOR query, (b) restore "ORDER BY view_name", (c) delete the predictive-skip
--   IF block, n_skipped, and the 'skipped' key in the returned jsonb.
--   Reverting is safe at any time: this function writes only to
--   public_board_liveness_state, a monitoring table with no product reader.
-- -----------------------------------------------------------------------------

DO $guard$
DECLARE v_src text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'public_board_liveness_sweep';

  IF v_src IS NULL THEN
    RAISE EXCEPTION 'public_board_liveness_sweep not found -- aborting';
  END IF;

  -- Assert we are replacing the exact shape this migration was written against.
  IF position('ORDER BY view_name' in v_src) = 0 THEN
    RAISE EXCEPTION 'anchor "ORDER BY view_name" not found -- definition drifted, aborting';
  END IF;
  IF position('n_skipped' in v_src) <> 0 THEN
    RAISE EXCEPTION 'this migration appears to be already applied -- aborting';
  END IF;
  IF position('count(t.*)' in v_src) = 0 THEN
    RAISE EXCEPTION 'anchor "count(t.*)" (planner-pinning guard) not found -- aborting';
  END IF;
END
$guard$;

CREATE OR REPLACE FUNCTION public.public_board_liveness_sweep(p_budget_ms integer DEFAULT 600000)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  r         record;
  v_reg     regclass;
  v_cnt     bigint;
  v_whole   bigint;
  v_t0      timestamptz := clock_timestamp();
  v_tv      timestamptz;
  v_ms      integer;
  v_err     text;
  v_sqlst   text;
  v_spent   numeric;
  n_probed  integer := 0;
  n_empty   integer := 0;
  n_slow    integer := 0;
  n_skipped integer := 0;
  n_active  integer;
  v_bust    boolean := false;
BEGIN
  SELECT count(*) INTO n_active FROM public.public_board_liveness_watchlist WHERE is_active;

  FOR r IN
    WITH est AS (
      SELECT h.view_name,
             percentile_disc(0.9) WITHIN GROUP (ORDER BY h.elapsed_ms) AS p90_ms
        FROM public.public_board_liveness_history h
       WHERE h.checked_at > now() - interval '14 days'
         AND h.elapsed_ms IS NOT NULL
       GROUP BY h.view_name
    )
    SELECT w.view_name,
           w.min_rows,
           w.max_ms,
           COALESCE(e.p90_ms, w.max_ms * 2)::numeric AS est_ms
      FROM public.public_board_liveness_watchlist w
      LEFT JOIN public.public_board_liveness_state s ON s.view_name = w.view_name
      LEFT JOIN est e                                ON e.view_name = w.view_name
     WHERE w.is_active
     -- ROTATION: least-recently-probed first. Never-probed boards (NULL) lead.
     -- view_name is the tiebreak so the order stays deterministic within a tick.
     ORDER BY s.checked_at NULLS FIRST, w.view_name
  LOOP
    v_spent := EXTRACT(epoch FROM clock_timestamp() - v_t0) * 1000;

    -- Hard soft-deadline: budget already gone.
    IF v_spent > p_budget_ms THEN
      v_bust := true;
      EXIT;
    END IF;

    -- PREDICTIVE SKIP. We cannot preempt a running board (see migration header),
    -- so we decline to START one whose own p90 will not fit in what is left.
    -- The first board is exempt: that guarantees forward progress on the single
    -- most expensive view, which rotation then moves to the back next cycle.
    IF n_probed > 0 AND v_spent + r.est_ms > p_budget_ms THEN
      n_skipped := n_skipped + 1;
      v_bust    := true;   -- coverage is incomplete this tick; stay INCONCLUSIVE
      CONTINUE;
    END IF;

    v_cnt := NULL; v_ms := NULL; v_err := NULL; v_sqlst := NULL;
    v_reg := to_regclass('public.' || quote_ident(r.view_name));

    IF v_reg IS NULL THEN
      v_err := 'object not found in schema public';
    ELSE
      v_tv := clock_timestamp();
      BEGIN
        -- count(*) is the honest row count; count(t.*) exists ONLY to reference the whole
        -- row so the planner cannot remove the view's joins. Dropping it silently restores
        -- the false-green this migration fixes. Do not "simplify" it away.
        EXECUTE format('SELECT count(*), count(t.*) FROM %s t', v_reg) INTO v_cnt, v_whole;
        v_ms := round(EXTRACT(epoch FROM clock_timestamp() - v_tv) * 1000);
      EXCEPTION WHEN OTHERS THEN
        v_ms    := round(EXTRACT(epoch FROM clock_timestamp() - v_tv) * 1000);
        v_sqlst := SQLSTATE;
        v_err   := left(SQLSTATE || ': ' || SQLERRM, 500);
      END;
    END IF;

    INSERT INTO public.public_board_liveness_state (view_name, row_count, elapsed_ms, err, checked_at)
    VALUES (r.view_name, v_cnt, v_ms, v_err, now())
    ON CONFLICT (view_name) DO UPDATE
      SET row_count  = EXCLUDED.row_count,
          elapsed_ms = EXCLUDED.elapsed_ms,
          err        = EXCLUDED.err,
          checked_at = EXCLUDED.checked_at;

    n_probed := n_probed + 1;

    -- A TIMEOUT is SLOW, not EMPTY: the board renders, it just renders too slowly. Any other
    -- error is EMPTY, because a view that throws and a view with no rows render the identical
    -- blank board to the fail-soft page.
    IF v_sqlst = '57014' THEN
      n_slow := n_slow + 1;
    ELSIF v_err IS NOT NULL THEN
      n_empty := n_empty + 1;
    ELSE
      IF COALESCE(v_cnt, -1) < r.min_rows      THEN n_empty := n_empty + 1; END IF;
      IF COALESCE(v_ms, 0)  > r.max_ms         THEN n_slow  := n_slow  + 1; END IF;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'probed', n_probed,
    'active', n_active,
    'skipped', n_skipped,
    'empty_or_error', n_empty,
    'slow', n_slow,
    'budget_exhausted', v_bust,
    'sweep_ms', round(EXTRACT(epoch FROM clock_timestamp() - v_t0) * 1000),
    'checked_at', now()
  );
END;
$function$;

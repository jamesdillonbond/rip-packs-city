-- Snapshot migration: public.public_board_liveness_sweep(integer).
--
-- Commits the CURRENT LIVE definition verbatim (pg_get_functiondef read 2026-08-22;
-- byte-identical, md5 583c04a933f7017378c891ae7e8cafcd — verified against the
-- database's own md5 rather than by eye). Applying it is a NO-OP against prod.
--
-- WHY IT EXISTS. `db-pin-staleness` had reported this pin STALE on every run since
-- 2026-08-10 (known-issues #24). ⚠ The drift is a COHERENT FEATURE, not rot, and the
-- slow-vs-empty classification this instrument exists for is unchanged:
--   * ROTATION — boards are probed least-recently-checked first (never-probed lead),
--     with view_name as a deterministic tiebreak, so a starved board cannot stay
--     starved across ticks;
--   * a 14-day per-board MEDIAN cost estimate (p50, deliberately not p90);
--   * a PREDICTIVE SKIP that declines to START a board whose estimate will not fit
--     the remaining budget, because a running board cannot be preempted;
--   * the `skipped` counter in the returned envelope.
--
-- ⚠ THE HONESTY PROPERTY IS THE LAST LINE OF THE SKIP BRANCH, not the counter:
-- a skip ALSO sets budget_exhausted. Without it a tick that quietly checked one board
-- of four would report probed=1 with budget_exhausted=false and read as a clean sweep
-- of a short watchlist — the same false-green the budget path already guards, arriving
-- by a different door. The pinned test mutation-tests exactly that line.
--
-- ── anon-execute decision (guard: __tests__/migration-new-function-states-its-anon-exec-decision.test.ts) ──
-- anon-exec: unchanged — public_board_liveness_sweep is ALREADY revoked in prod.
-- Verified 2026-08-22 with has_function_privilege (not the acl text): anon EXECUTE
-- false, authenticated EXECUTE false, service_role EXECUTE true. It is an operator
-- instrument run from pg_cron, never reachable from a browser.
-- ⚠ Deliberately a MARKER and not a REVOKE: this is a byte-identical snapshot, and
-- CREATE OR REPLACE FUNCTION does NOT reset a function's ACL, so adding a REVOKE here
-- would CHANGE production while presenting itself as a no-op.
--
-- REVERT: none needed — this is a no-op capture of what prod already runs.

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
      -- MEDIAN, not p90. See migration header: summing per-board p90 overstates a
      -- real sweep ~10x and would skip boards that routinely finish inside budget.
      SELECT h.view_name,
             percentile_disc(0.5) WITHIN GROUP (ORDER BY h.elapsed_ms) AS p50_ms
        FROM public.public_board_liveness_history h
       WHERE h.checked_at > now() - interval '14 days'
         AND h.elapsed_ms IS NOT NULL
       GROUP BY h.view_name
    )
    SELECT w.view_name,
           w.min_rows,
           w.max_ms,
           COALESCE(e.p50_ms, w.max_ms * 2)::numeric AS est_ms
      FROM public.public_board_liveness_watchlist w
      LEFT JOIN public.public_board_liveness_state s ON s.view_name = w.view_name
      LEFT JOIN est e                                ON e.view_name = w.view_name
     WHERE w.is_active
     -- ROTATION: least-recently-probed first. Never-probed boards (NULL) lead.
     -- view_name is the tiebreak so the order stays deterministic within a tick.
     ORDER BY s.checked_at NULLS FIRST, w.view_name
  LOOP
    v_spent := EXTRACT(epoch FROM clock_timestamp() - v_t0) * 1000;

    IF v_spent > p_budget_ms THEN
      v_bust := true;
      EXIT;
    END IF;

    -- PREDICTIVE SKIP. A running board cannot be preempted (a per-board
    -- statement_timeout does not work: the timer is armed once at the top-level
    -- statement and is re-armed by neither SET LOCAL nor COMMIT -- both verified
    -- empirically 2026-08-16). So we decline to START a board whose median cost
    -- will not fit in what is left. The first board is exempt, which guarantees
    -- forward progress on even the most pathological view; rotation then moves it
    -- to the back of the next cycle.
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

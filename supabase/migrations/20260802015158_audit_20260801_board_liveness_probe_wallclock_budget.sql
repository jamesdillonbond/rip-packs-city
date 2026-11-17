-- audit_20260801_board_liveness_probe_wallclock_budget
--
-- Adds a wall-clock budget to the board-liveness probe. Measured 43.8s warm /
-- 76.6s cold across 47 views, so an unbounded loop over a watchlist that only
-- ever grows is a slow-motion way to blow the 600s cron_heavy budget and take the
-- ENTIRE precompute refresher down with it -- which would age all 11 precomputed
-- metrics past 24h and mass-breach them at 999. The probe is a monitor; it must
-- not be able to break the thing it reports into.
--
-- On budget exhaustion the sweep stops and reports budget_exhausted=true. The
-- caller turns that into 999 (BREACH) rather than a partial count, because an
-- incomplete liveness sweep is INCONCLUSIVE and a monitor that cannot finish must
-- be loud, not silently green -- the same convention as the ">24h precompute row
-- reads 999" rule the other arms use.
--
-- Budget 180000ms = 4.1x the measured warm sweep and 2.3x the cold sweep.
--
-- Revert: re-apply the prior 0-argument definition from
-- audit_20260801_public_board_liveness_watchlist, then
--   DROP FUNCTION IF EXISTS public.public_board_liveness_probe(integer);
CREATE OR REPLACE FUNCTION public.public_board_liveness_probe(p_budget_ms integer DEFAULT 180000)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  r        record;
  v_reg    regclass;
  v_cnt    bigint;
  v_t0     timestamptz := clock_timestamp();
  v_tv     timestamptz;
  v_ms     integer;
  v_err    text;
  n_probed integer := 0;
  n_empty  integer := 0;
  n_slow   integer := 0;
  n_active integer;
  v_bust   boolean := false;
BEGIN
  SELECT count(*) INTO n_active FROM public.public_board_liveness_watchlist WHERE is_active;

  FOR r IN
    SELECT view_name, min_rows, max_ms
      FROM public.public_board_liveness_watchlist
     WHERE is_active
     ORDER BY view_name
  LOOP
    IF EXTRACT(epoch FROM clock_timestamp() - v_t0) * 1000 > p_budget_ms THEN
      v_bust := true;
      EXIT;
    END IF;

    v_cnt := NULL; v_ms := NULL; v_err := NULL;
    v_reg := to_regclass('public.' || quote_ident(r.view_name));

    IF v_reg IS NULL THEN
      v_err := 'object not found in schema public';
    ELSE
      v_tv := clock_timestamp();
      BEGIN
        EXECUTE format('SELECT count(*) FROM %s', v_reg) INTO v_cnt;
        v_ms := round(EXTRACT(epoch FROM clock_timestamp() - v_tv) * 1000);
      EXCEPTION WHEN OTHERS THEN
        v_ms  := round(EXTRACT(epoch FROM clock_timestamp() - v_tv) * 1000);
        v_err := left(SQLSTATE || ': ' || SQLERRM, 500);
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
    -- An ERRORED probe counts as EMPTY: from the fail-soft page's point of view a
    -- view that throws and a view with no rows render the identical blank board.
    IF v_err IS NOT NULL OR COALESCE(v_cnt, -1) < r.min_rows THEN
      n_empty := n_empty + 1;
    END IF;
    IF v_err IS NULL AND COALESCE(v_ms, 0) > r.max_ms THEN
      n_slow := n_slow + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'probed', n_probed,
    'active', n_active,
    'empty_or_error', n_empty,
    'slow', n_slow,
    'budget_exhausted', v_bust,
    'sweep_ms', round(EXTRACT(epoch FROM clock_timestamp() - v_t0) * 1000),
    'checked_at', now()
  );
END;
$function$;

DROP FUNCTION IF EXISTS public.public_board_liveness_probe();

REVOKE EXECUTE ON FUNCTION public.public_board_liveness_probe(integer) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.public_board_liveness_probe(integer) TO service_role;
-- audit_20260801_public_board_liveness_watchlist
--
-- Closes the "a public board view returns ZERO rows and nothing notices" class.
-- Every /insights board is fail-soft: the server page catches the query error /
-- timeout and renders the empty state, so "Holders 0" is indistinguishable from a
-- real outage. That is exactly how candy_holder_board (373 collectors) rendered 0
-- for days with zero Sentry and zero alerts -- it was SLOW (an 82s read against the
-- request budget), not empty.
--
-- Design notes:
--  * The watchlist is a TABLE, not a hardcoded list inside a view, so adding a
--    board is an INSERT and not a migration against a 900-line view definition.
--  * Probing is deliberately NOT done in v_rpc_trust_health. Counting a dozen
--    board views on every sentinel read would cost more than the thing it
--    monitors on an instance where DB time is the binding constraint. The probe
--    runs in the 6-hourly precompute path; the view reads two scalars.
--  * ELAPSED time is captured alongside row count because the motivating failure
--    was slowness, not emptiness -- a view that takes 80s is "empty" from the
--    app's point of view while count(*) still returns rows.
--  * Boards that can LEGITIMATELY be empty (candy_deals_board reads 0 whenever no
--    listing is below FMV) are carried with is_active=false + a note rather than
--    omitted, so the decision is visible and reversible.
--
-- Revert:
--   DROP FUNCTION IF EXISTS public.public_board_liveness_probe();
--   DROP TABLE IF EXISTS public.public_board_liveness_state;
--   DROP TABLE IF EXISTS public.public_board_liveness_watchlist;

CREATE TABLE IF NOT EXISTS public.public_board_liveness_watchlist (
  view_name  text PRIMARY KEY,
  min_rows   integer NOT NULL DEFAULT 1,
  max_ms     integer NOT NULL DEFAULT 5000,
  is_active  boolean NOT NULL DEFAULT true,
  note       text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.public_board_liveness_state (
  view_name  text PRIMARY KEY,
  row_count  bigint,
  elapsed_ms integer,
  err        text,
  checked_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.public_board_liveness_watchlist IS
  'Allowlist of PUBLIC /insights board-backing views that must always return rows. Feeds the public_board_empty_count / public_board_slow_count trust-health arms via rpc_trust_health_precompute_refresh(). Add a board with an INSERT; retire one with is_active=false + a note (never DELETE, so the decision stays auditable).';
COMMENT ON COLUMN public.public_board_liveness_watchlist.min_rows IS
  'Breach if count(*) < this. Set WELL below the observed population (~25% for row-y boards, exactly 1 for single-row summary views) so it catches a collapse, not churn.';
COMMENT ON COLUMN public.public_board_liveness_watchlist.max_ms IS
  'Breach if the warm probe exceeds this. Set ~3x measured-warm: a board 3x slower warm is the early warning for the cold/contended blowup that makes a fail-soft page render empty.';
COMMENT ON TABLE public.public_board_liveness_state IS
  'Last probe result per watchlisted view (row count, elapsed ms, error text). Written by public_board_liveness_probe(); read only by the precompute refresher. Diagnostic detail behind the two aggregate trust-health arms.';

ALTER TABLE public.public_board_liveness_watchlist ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.public_board_liveness_state     ENABLE ROW LEVEL SECURITY;

-- Supabase's default per-role grant survives REVOKE ... FROM PUBLIC, so revoke the
-- roles EXPLICITLY (CLAUDE.md: route-gating is not data-gating).
REVOKE ALL ON public.public_board_liveness_watchlist FROM anon, authenticated, PUBLIC;
REVOKE ALL ON public.public_board_liveness_state     FROM anon, authenticated, PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.public_board_liveness_watchlist TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.public_board_liveness_state     TO service_role;

-- Probe: for each ACTIVE watchlisted view, time a count(*) and record it.
-- to_regclass() both validates the object exists in public and yields a safely
-- quoted identifier for the dynamic SQL, so view_name can never be an injection
-- vector. A per-view failure (missing object, permission, timeout) is CAUGHT and
-- recorded as err -- one broken board can never abort the sweep or the refresher.
CREATE OR REPLACE FUNCTION public.public_board_liveness_probe()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  r        record;
  v_reg    regclass;
  v_cnt    bigint;
  v_t0     timestamptz;
  v_ms     integer;
  v_err    text;
  n_probed integer := 0;
  n_empty  integer := 0;
  n_slow   integer := 0;
BEGIN
  FOR r IN
    SELECT view_name, min_rows, max_ms
      FROM public.public_board_liveness_watchlist
     WHERE is_active
     ORDER BY view_name
  LOOP
    v_cnt := NULL; v_ms := NULL; v_err := NULL;
    v_reg := to_regclass('public.' || quote_ident(r.view_name));

    IF v_reg IS NULL THEN
      v_err := 'object not found in schema public';
    ELSE
      v_t0 := clock_timestamp();
      BEGIN
        EXECUTE format('SELECT count(*) FROM %s', v_reg) INTO v_cnt;
        v_ms := round(EXTRACT(epoch FROM clock_timestamp() - v_t0) * 1000);
      EXCEPTION WHEN OTHERS THEN
        v_ms  := round(EXTRACT(epoch FROM clock_timestamp() - v_t0) * 1000);
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
    'empty_or_error', n_empty,
    'slow', n_slow,
    'checked_at', now()
  );
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.public_board_liveness_probe() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.public_board_liveness_probe() TO service_role;
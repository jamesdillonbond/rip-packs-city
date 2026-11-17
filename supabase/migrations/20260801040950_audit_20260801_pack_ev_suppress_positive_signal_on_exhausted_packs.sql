-- 23 pack distributions published is_positive_ev = TRUE on packs that cannot be
-- bought or opened: 14 Disney Pinnacle + 9 LaLiga Golazos, all with total_unopened
-- <= 0 (two NEGATIVE) and/or depletion_pct >= 100. The worst is Golazos dist 1
-- "Jornadas 1-9 (Stress test)" -- an internal test pack -- at $4.99 with
-- gross_ev $29.36, is_positive_ev TRUE, total_unopened -486, depletion 100%.
--
-- is_positive_ev is a BUY SIGNAL. On an exhausted pool it is not merely stale, it
-- is unactionable by construction.
--
-- Top Shot already behaves correctly (331 rows with total_unopened <= 0, ZERO
-- flagged positive) and AllDay has no affected rows, so this guard is a no-op for
-- both -- it only closes the gap on the two collections whose EV is computed by a
-- different path (Golazos via the AllDay-clone edge fn, Pinnacle inline).
--
-- MINIMAL BY DESIGN: suppresses ONLY the boolean. gross_ev / pack_ev / value_ratio
-- are left intact so the "what would this have been worth" number still renders --
-- matching how Top Shot already presents depleted packs.
-- Extends the view's existing sentinel-NULLing pattern rather than inventing one.
-- REVERT: remove the added WHEN arm from the is_positive_ev CASE in pack_ev_latest.
DO $mig$
DECLARE
  v_def text;
  v_old text := 'THEN NULL::boolean
            ELSE is_positive_ev';
  v_new text := 'THEN NULL::boolean
            WHEN (total_unopened IS NOT NULL AND total_unopened <= 0) OR (depletion_pct IS NOT NULL AND depletion_pct >= 100) THEN false
            ELSE is_positive_ev';
BEGIN
  v_def := pg_get_viewdef('public.pack_ev_latest'::regclass, true);
  IF position(v_old in v_def) = 0 THEN
    RAISE EXCEPTION 'is_positive_ev CASE arm not found verbatim in pack_ev_latest - aborting rather than silently no-op';
  END IF;
  EXECUTE 'CREATE OR REPLACE VIEW public.pack_ev_latest AS ' || replace(v_def, v_old, v_new);
END
$mig$;

ALTER VIEW public.pack_ev_latest SET (security_invoker = on);
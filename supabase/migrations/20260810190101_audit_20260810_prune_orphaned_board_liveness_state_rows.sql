-- audit_20260810_prune_orphaned_board_liveness_state_rows
--
-- Cosmetic cleanup flagged by two independent 2026-08-10 inbox files.
-- `public_board_liveness_state` held 47 rows vs 45 active watchlist entries:
-- `candy_deals_board` and `topshot_underpriced_serials_board` were set
-- is_active=false in the watchlist but their state rows were never deleted,
-- so they sat frozen at 2026-08-02 01:40Z (>200h stale). They do NOT inflate
-- any trust arm (the probe derives n_slow/n_empty from its own loop over
-- ACTIVE watchlist rows, never from this table), but a >200h-stale row makes
-- the state table actively misleading to read by hand — it confused a sweep.
--
-- Guarded delete: removes only state rows whose view_name has NO active
-- watchlist entry, so a board re-activated later is never pruned. The probe
-- re-creates a state row for any active board on its next sweep, so this
-- cannot lose live signal.
--
-- Not a circuit-breaker-guarded table (wmc/editions/pinnacle_editions only).
--
-- Revert: none needed — the probe repopulates any board that becomes active
-- again. (These two rows carry no recoverable information; they are stale
-- snapshots of inactive boards.)

DELETE FROM public.public_board_liveness_state s
WHERE NOT EXISTS (
  SELECT 1 FROM public.public_board_liveness_watchlist w
  WHERE w.view_name = s.view_name AND w.is_active
);

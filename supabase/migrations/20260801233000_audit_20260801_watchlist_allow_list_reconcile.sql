-- audit_20260801_watchlist_allow_list_reconcile
--
-- `allow-list-reconcile` runs hourly and was on NO cadence watchlist, so when
-- GitHub Actions silently dropped ~60% of its ticks (measured 2026-08-01: ~9 of
-- the 24 daily runs its '14 * * * *' schedule implies) nothing could see it.
-- That invisibility is the worse half of the finding — the same GHA dropout on
-- `topshot-listing-cache` was ALSO invisible, but for a different reason: it IS
-- watchlisted, at max_silent_minutes = 360, and even at ~17% delivery it still
-- fired roughly every 2h, so it never breached the 6h threshold. A cadence
-- watchlist keyed only on SILENCE cannot see partial tick loss.
--
-- 240 minutes = 4 missed hourly ticks. Deliberately loose rather than 120: this
-- lands in the same commit that moves the schedule from GitHub Actions to a
-- Vercel cron, and a tight threshold during a scheduler migration would page on
-- the migration itself rather than on a real outage. `info` severity because this
-- is an allow-list prewarm reconcile, not a data pipeline — it should be visible,
-- not wake anyone up.
--
-- Revert:
--   DELETE FROM public.pipeline_cadence_watchlist WHERE pipeline = 'allow-list-reconcile';

INSERT INTO public.pipeline_cadence_watchlist (pipeline, max_silent_minutes, severity, notes, is_active)
VALUES (
  'allow-list-reconcile',
  240,
  'info',
  'Hourly allow_list prewarm reconcile. Added 2026-08-01 with the GHA->Vercel cron move; it had NO watchlist row, so a ~60% GitHub Actions tick loss was completely invisible. 240m = 4 missed hourly ticks, deliberately loose while the new Vercel schedule beds in.',
  true
)
ON CONFLICT (pipeline) DO NOTHING;

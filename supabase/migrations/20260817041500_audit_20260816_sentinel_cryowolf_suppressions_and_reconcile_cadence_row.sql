-- audit_20260816 (PT) / 2026-08-17 UTC: quiet two CRY-WOLF failure_rate alerts and close the
-- coverage gap that suppressing one of them would otherwise have opened.
--
-- ⚠ APPLIED AT RUNTIME VIA execute_sql, NOT apply_migration. This file is the idempotent RECORD
-- for repo<->prod parity (same pattern as 20260816014000). It is therefore deliberately ABSENT
-- from supabase_migrations.schema_migrations -- do NOT read that absence as "never applied".
-- These are pure DML on two config tables (no DDL), and apply_migration would have invalidated
-- the PostgREST schema cache for a ~10-20s burst of user-facing 500s to no purpose.
--
-- CONTEXT: the sentinel digest showed 8 'high' alerts. Two of them were reporting designed
-- behaviour as breakage, which is the ufc_fmv_stale_hours cry-wolf shape this repo has twice had
-- to rescue the board from. Paging tier verified 8 -> 6 after applying.
--
-- 1. reconcile-saved-wallet-stats
--    100% of its failing runs (24/24 over 2 days) carry the single error
--    'soft_deadline_reached_partial_sweep_committed', and those same "failed" runs WROTE 164 rows.
--    Migration 20260816014000 established that ok=false is the deliberate, honest "did not finish"
--    signal for a resumable partial sweep. The failure_rate arm counts it as breakage, permanently,
--    at ~80%.
--    ⚠ It had NO pipeline_cadence_watchlist row, so suppressing alone would have left ZERO
--    coverage. The cadence row below is added FIRST so a total stop is still caught.
--
-- 2. allday-unmapped-resolver-tail
--    62.5% failures, all 'resolve:upstream request timeout' (transport/saturation), 0 rows written.
--    CLAUDE.md and the route's own 2026-07-27 probe establish that ~0 resolutions on a healthy
--    transport is the EXPECTED steady state of an exhausted backlog, and state outright: do NOT
--    open it as an incident. The genuine open item is a cost/benefit question (is ~1.7
--    resolutions/day worth its share of a saturated IO budget), filed separately and forced back
--    into view by the bounded expiry.
--
-- Both suppressions are BOUNDED (2026-11-15), not permanent, so neither can hide a changed failure
-- mode indefinitely. Full predicates + live evidence are stored in each row's `reason`.
--
-- REVERT (restores the pre-change state exactly):
--   DELETE FROM public.pipeline_alert_suppression   WHERE pipeline = 'reconcile-saved-wallet-stats';
--   DELETE FROM public.pipeline_alert_suppression   WHERE pipeline = 'allday-unmapped-resolver-tail';
--   DELETE FROM public.pipeline_cadence_watchlist   WHERE pipeline = 'reconcile-saved-wallet-stats';

-- Coverage first: a cadence arm so a TOTAL STOP is still caught once failure_rate is suppressed.
INSERT INTO public.pipeline_cadence_watchlist (pipeline, max_silent_minutes, severity, notes, is_active)
VALUES (
  'reconcile-saved-wallet-stats', 150, 'medium',
  'Saved-wallet card refresh (backs dashboard / /profile / /share cached_moment_count + cached_fmv_usd + cached_top_tier). pg_cron jobid 259, hourly at :44 since migration 20260816014000. ADDED 2026-08-16: this pipeline had NO cadence row at all, so once its failure_rate alert was suppressed as cry-wolf it would have had ZERO coverage and a total stop would have been invisible. 150 min = 2 missed hourly runs plus slack. Do NOT re-point this at ok/failure: by design a truncated partial sweep returns ok=false (soft_deadline_reached_partial_sweep_committed) while COMMITTING its work per-wallet, so failure rate is not a health signal here -- SILENCE is. See the paired pipeline_alert_suppression row.',
  true
)
ON CONFLICT (pipeline) DO NOTHING;

-- Then the two bounded suppressions. Reasons are stored in-row (see the live table for full text).
INSERT INTO public.pipeline_alert_suppression (pipeline, reason, expires_at)
VALUES
  ('reconcile-saved-wallet-stats',
   'Designed graceful degradation misread as failure -- see the live row for the full predicate, live evidence and revert path. Paired with a pipeline_cadence_watchlist row so a total stop is still caught.',
   '2026-11-15 00:00:00+00'),
  ('allday-unmapped-resolver-tail',
   'Exhausted backlog grinding against a saturated instance -- not a defect per CLAUDE.md and the route''s own 2026-07-27 control probe. See the live row for the full predicate and the open cost/benefit question.',
   '2026-11-15 00:00:00+00')
ON CONFLICT (pipeline) DO NOTHING;

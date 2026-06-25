-- Watchlist the UFC studio-platform deep-history drain. Unlike the other 3 studio
-- crons (every 3h, watchlisted at 600m), UFC runs every 20 min (1,21,41 * * * *) as
-- a single global cursor walk, so 90 min silence / medium = ~3 missed ticks + grace
-- without false-positiving. It banked 6 consecutive clean ticks (gate = 2) before
-- this landed; self-terminates to a cheap no-op post-drain (still fires every 20 min,
-- so 90m holds). detect_stalled_pipelines() does NOT list it after apply.
-- Applied live 2026-06-25 (audit_20260625_watchlist_ufc_studio_sales_history_backfill);
-- repo-parity copy, record-only — never re-applied (prod already migrated).
-- Revert: DELETE FROM public.pipeline_cadence_watchlist WHERE pipeline='ufc-studio-sales-history-backfill';

INSERT INTO public.pipeline_cadence_watchlist (pipeline, max_silent_minutes, severity, notes, is_active)
VALUES ('ufc-studio-sales-history-backfill', 90, 'medium',
        'UFC studio deep-history drain — 20-min cadence (1,21,41 * * * *); self-terminates to no-op post-drain', true)
ON CONFLICT (pipeline) DO NOTHING;

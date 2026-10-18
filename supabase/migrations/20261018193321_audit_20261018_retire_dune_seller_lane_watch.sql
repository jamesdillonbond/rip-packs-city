-- 2026-10-18 12:33 PM PT (Cowork cloud; Trevor "Keep going. Don't stop until you've completely exhausted your capabilities").
-- `sales-seller-recovery-dune` is retired SCHEDULE-ONLY (vercel.json `47 * * * *` removed in the
-- same change; the route and its state are kept, revivable). Since 2026-09-10 every run stops on
-- dune_budget_state.paused (the free tier went view-only; reviving needs a paid plan, and there is
-- no spend pre-revenue): 24 runs/day, 0 found, 0 written, ~0.2 s each. Its cadence watch row would
-- trip on the silence a retired schedule creates, so it is deactivated here with the reason.
-- Precedent: sync-sales-ingest-dune, retired schedule-only 2026-07-28.
-- REVERT: UPDATE pipeline_cadence_watchlist SET is_active = true WHERE pipeline = 'sales-seller-recovery-dune';
--         and re-add {"path": "/api/cron/sync-sales-seller-recovery-dune", "schedule": "47 * * * *"} to vercel.json.
DO $$
DECLARE n int;
BEGIN
  UPDATE public.pipeline_cadence_watchlist
     SET is_active = false,
         notes = notes || ' | 2026-10-18: DEACTIVATED, schedule retired (Dune budget paused since 2026-09-10, free tier view-only, no paid plan). Re-activate with the vercel.json entry.'
   WHERE pipeline = 'sales-seller-recovery-dune' AND is_active;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'expected 1 active watch row, updated %', n; END IF;
END $$;

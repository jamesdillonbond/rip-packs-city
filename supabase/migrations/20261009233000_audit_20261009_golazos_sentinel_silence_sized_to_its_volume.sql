-- audit_20261009_golazos_sentinel_silence_sized_to_its_volume
--
-- ✅ APPLIED 2026-10-09 ~11:04 PM PT via the dashboard SQL editor (Cowork cloud; schema_migrations row 20261009233000 inserted by hand; verified by read: silence_hours 504). Earlier status kept below.
-- ⏸ STATUS 2026-10-09 ~4:25 PM PT: NOT YET APPLIED. apply_migration was HELD by the Supabase MCP's
-- human-confirmation gate (60 s timeout; re-read: silence_hours still 168). Paste this whole file into
-- the Supabase SQL editor. The UPDATE is guarded (AND silence_hours = 168), so a re-paste is a no-op.
-- Verify: select silence_hours from sentinel_ingest_watch where collection_key = 'laliga_golazos'; -> 504,
-- and the next hourly SENTINEL drops the "Golazos … >168h!" warn.
--
-- Trevor 2026-10-09 (~4:20 PM PT): "Raise the silence limit on Golazos due to its overall volume being
-- so low."
--
-- The sentinel's "Sales Ingest by Collection" arm read WARN on every hourly run of 10-09 for one reason:
-- "Golazos 0/24h (last 184.6h ago >168h!)". The 168 h ceiling (seeded 08-08 from a 14-day sample whose
-- worst gap was 87.8 h) is inside Golazos's NORMAL behaviour. Measured over 180 days at ~4:20 PM PT:
-- 518 sales (55 in the last 30 d), p99 gap between consecutive sales 112 h, worst gap 463 h (~19 days).
-- The current 186 h silence was verified as a quiet MARKET, not a broken indexer: 0 Golazos.Withdraw /
-- Deposit events on chain in a 5,000-block sample against 31 AllDay.Withdraw, while the
-- golazos-sales-indexer cursor advances every tick.
--
-- Change: silence_hours 168 -> 504 (21 days, just above the worst observed normal gap); loudness stays
-- 'warn'. A dead INGEST is still caught independently: golazos-sales-indexer / golazos-listings-indexer
-- carry their own cadence-watchlist arms, and both log cursor_after on every run.
-- ⚠ Revisit if Golazos volume recovers (re-derive the gap distribution) or the market is declared
-- closed (then loudness 'off' plus a lib/market-closed.ts entry, the UFC pattern).
--
-- REVERT: UPDATE public.sentinel_ingest_watch SET silence_hours = 168,
--           note = 'thin/listing-gated; worst normal 14d gap 87.8h -> only a multi-day death fires'
--         WHERE collection_key = 'laliga_golazos';

UPDATE public.sentinel_ingest_watch
   SET silence_hours = 504,
       note = 'thin/listing-gated; 180 d to 2026-10-09: 518 sales, p99 gap 112 h, worst gap 463 h -> 504 h (21 d) ceiling (Trevor 10-09: volume too low for 168 h). Ingest death is caught by the indexers'' own cadence arms.'
 WHERE collection_key = 'laliga_golazos' AND silence_hours = 168;

DO $$
BEGIN
  IF (SELECT silence_hours FROM public.sentinel_ingest_watch WHERE collection_key = 'laliga_golazos') <> 504 THEN
    RAISE EXCEPTION 'golazos silence_hours not raised';
  END IF;
END $$;

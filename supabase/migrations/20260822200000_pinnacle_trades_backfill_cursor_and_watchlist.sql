-- Pinnacle TRADE lane, part 2: the history backfill cursor + a cadence arm.
--
-- Part 1 (20260822180000) shipped the forward lane. It is verified live:
--   01:00:19Z  cursor 162,153,000 → 162,155,000, 0 trades, 0 decode failures
--   01:10:40Z  cursor 162,155,000 → 162,157,000, 1 trade / 6 Pins WRITTEN
-- The first tick's 145,951 ms was a cold start; the second was 22,330 ms.
--
-- ── 1. BACKFILL CURSOR ──────────────────────────────────────────────────────
-- The backfill cursor means the LOWEST block scanned so far and counts DOWN,
-- the opposite of every other row in this table. Seeded at 162,153,001 = the
-- forward seed + 1, so the two lanes TILE EXACTLY with no gap and no overlap:
--   forward  owns (162,153,000, tip]
--   backfill owns [137,390,146, 162,153,000]
-- 137,390,146 is the current spork floor; public Flow REST 404s below it, so
-- deeper history needs the spork proxy worker (separate workstream).
--
-- ⚠ WHY A BACKFILL IS WORTH RUNNING AT ALL — measured, 2026-08-22. Six 2,500-
-- block windows sampled across the reachable range, ALL 60 reads HTTP 200 (so
-- every zero below is a real zero, not a failed read):
--     162.15M (~now)    12 withdraw tx,  2 trade-candidate tx,  13 Pins
--     158.0M  (~-60d)    0               0                       0
--     154.0M  (~-118d)   0               0                       0
--     150.0M  (~-176d)   6               0                       0
--     145.0M  (~-248d)  89              11                     264
--     138.0M  (~-350d)   0               0                       0
-- Trading around 145M ran ~20x today's rate, so history has real content.
-- ⚠ THIS IS NOT A TIME SERIES. Six ~52-minute samples cannot support a trend;
-- they establish "history is worth reading", nothing more. Do not quote the
-- shape of this table as a trend line.
--
-- ⚠ ROW-COUNT ESTIMATE IS UNCERTAIN BY ~20x, AND THAT IS THE OPEN RISK. At
-- today's rate the full backfill lands ~130k rows; at the 145M rate, ~2.6M.
-- This instance is Small compute on a disk-IO burst budget where saturation is
-- the dominant operational problem, so the cadence is deliberately modest and
-- the WRITE RATE SHOULD BE RE-MEASURED after a few hours rather than assumed.
-- To pause: remove the backfill entry from vercel.json (one line, no DB change).
INSERT INTO public.event_cursor (id, last_processed_block, updated_at)
VALUES ('pinnacle_trades_backfill', 162153001, now())
ON CONFLICT (id) DO NOTHING;

-- ── 2. CADENCE ARM (forward lane only) ──────────────────────────────────────
-- ⚠ Sized from the SCHEDULE, not from a measured gap distribution — the lane is
-- hours old and two ticks are not a distribution. vercel.json runs it */10, so
-- 60m absorbs five consecutive missed ticks before firing, the same convention
-- the */15 pinnacle-events-ingest row uses. Re-derive from pipeline_runs_daily
-- once there are a few days of history.
--
-- ⚠ THE BACKFILL LANE IS DELIBERATELY *NOT* WATCHED. It is a finite campaign:
-- when it reaches the spork floor it logs phase 'backfill_floor_reached' and
-- stops doing work, so a silence arm on it would go red exactly when it
-- SUCCEEDED, and this file's own canon says a permanently-red instrument is
-- indistinguishable from a broken one at a glance. Watch its progress by the
-- cursor, not by an alarm.
--
-- severity 'medium' = visibility, does not page. Honest for a lane whose only
-- consumer today is the acquisitions backfill; raise it if a public surface
-- starts reading pinnacle_trade_events.
INSERT INTO public.pipeline_cadence_watchlist (pipeline, max_silent_minutes, severity, notes, is_active)
VALUES (
  'pinnacle-trades-indexer',
  60,
  'medium',
  'Disney Pinnacle peer-to-peer TRADE ingest — the third Pinnacle transaction type, added 2026-08-22. '
  'Vercel cron */10 (forward lane). 60m absorbs five missed ticks. Sized from the SCHEDULE, not a measured '
  'gap distribution — re-derive from pipeline_runs_daily once several days exist. The BACKFILL lane '
  '(mode=backfill, cursor pinnacle_trades_backfill) is intentionally unwatched: it is a finite campaign and '
  'a silence arm would fire when it completes. Revert: DELETE FROM pipeline_cadence_watchlist WHERE '
  'pipeline = ''pinnacle-trades-indexer'';',
  true
)
ON CONFLICT (pipeline) DO NOTHING;

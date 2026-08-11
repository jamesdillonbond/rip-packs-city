-- FALSE STALL, caught by detect_stalled_pipelines() within hours of the change
-- that caused it. Commit 44e97c34 (2026-08-01) correctly cut
-- `ufc-studio-sales-history-backfill` from `1,21,41 * * * *` (72 fires/day) to
-- roughly daily, because UFC's Flow market has been dead since 2026-05-13 and the
-- job was finding 0 rows on every single run. But its watchlist row still carried
-- `max_silent_minutes = 90`, sized for the retired 20-minute cadence — so the
-- FIRST normal gap under the new schedule tripped a stall (268 min silent vs 90).
--
-- DURABLE: changing a pipeline's CADENCE without re-sizing its cadence watchlist
-- manufactures a false alarm. The watchlist is the contract for "how often should
-- this be heard from" and has to move with the schedule. (Note the row's own
-- `notes` still described the old cron string — a stale note is the tell.)
--
-- 26h gives a daily job a full missed tick plus headroom before it pages, and
-- still catches a genuinely dead job within ~2 days. Severity stays `medium`:
-- this is a drained deep-history backfill against a dead market, so its silence
-- is not user-facing. Verified 59 runs in the last 24h are the pre-change ticks.
UPDATE public.pipeline_cadence_watchlist
   SET max_silent_minutes = 1560,
       notes = 'UFC studio deep-history drain against a DEAD Flow market (UFC migrated to Aptos 2026-05-13). '
               'Cadence cut 72/day -> daily by 44e97c34 (2026-08-01) since every run found 0 rows; '
               'threshold re-sized from 90min (the retired 20-min cadence) to 26h = one missed daily tick + headroom.'
 WHERE pipeline = 'ufc-studio-sales-history-backfill';
-- Revert: UPDATE public.pipeline_cadence_watchlist
--            SET max_silent_minutes = 90,
--                notes = 'UFC studio deep-history drain — 20-min cadence (1,21,41 * * * *); self-terminates to no-op post-drain'
--          WHERE pipeline = 'ufc-studio-sales-history-backfill';
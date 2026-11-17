-- 2026-10-19 (PT) — the expiry closer for cached_listings_v2 has had NO caller since 2026-05-30.
-- public.close_expired_cached_listings() (pinned: supabase/tests/close_expired_cached_listings.sql)
-- closes open rows whose on-chain expiry has passed. Nothing schedules it: no pg_cron job, no
-- in-repo fetch, no workflow. The last row it closed has completed_at 2026-05-30 (All Day) /
-- 2026-05-29 (Pinnacle). Measured 2026-10-19 ~4:40 PM PT:
--   * 16,194 rows still "open" (completed_at IS NULL) with expiry_at in the past, every one of them
--     disney_pinnacle source='direct' — 16,193 of that source's 45,808 open rows (35 %);
--   * a further 249 / 84 / 245 / 288 expire per day (10-16 → 10-19), so the pile keeps growing.
-- No live surface reads those rows today (the moment page, Sniper and concierge read Pinnacle from
-- pinnacle_live_listings / pinnacle_catalog; the SQL readers filter expiry_at), so this is not a
-- user-facing fix — it stops the table claiming 16k listings are open that the chain says are
-- closed, before the next reader trusts completed_at IS NULL.
-- Cost, measured (EXPLAIN ANALYZE BUFFERS of the UPDATE's predicate): 13,997 buffers / 52 ms via
-- idx_cl_v2_collection_active; no triggers on the table. Hourly at :49 (0 active jobs on that minute).
-- The command wraps the jsonb return in log_pipeline_run: rows_written = the RETURNING count, so it
-- means rows CLOSED; a failed UPDATE fails the statement and writes no row, which the watchlist
-- reads as silence (no fabricated ok=true).
-- Exit: pipeline 'close-expired-listings' logs hourly and the past-expiry open count stays ~0.
-- Falsifier: an open cached_listings_v2 row with expiry_at more than 2 h in the past.
-- Revert: SELECT cron.unschedule('rpc-close-expired-cached-listings-hourly');
--         DELETE FROM public.pipeline_cadence_watchlist WHERE pipeline = 'close-expired-listings';
--         (data: the closed rows carry completed_status='expired' AND completed_at = expiry_at;
--          there is no backup because re-opening an expired on-chain listing would be the error.)

INSERT INTO public.pipeline_cadence_watchlist (pipeline, max_silent_minutes, severity, notes, is_active, max_minutes_without_success)
VALUES ('close-expired-listings', 180, 'info',
  'pg_cron rpc-close-expired-cached-listings-hourly (49 * * * * UTC, postgres) -> close_expired_cached_listings() wrapped in log_pipeline_run: marks cached_listings_v2 rows past their on-chain expiry completed_status=expired. Uncalled 2026-05-30 -> 2026-10-19 (16,194 expired rows left open). Silence = the hourly tick did not run or the UPDATE failed; rows_written 0 is normal.',
  true, 240)
ON CONFLICT (pipeline) DO NOTHING;

SELECT cron.schedule('rpc-close-expired-cached-listings-hourly', '49 * * * *',
  $cmd$SELECT public.log_pipeline_run('close-expired-listings', now(), (x.r->>'closed')::int, (x.r->>'closed')::int, 0, true, NULL, NULL, NULL, NULL, x.r || jsonb_build_object('via', 'pg_cron')) FROM (SELECT public.close_expired_cached_listings() AS r) x;$cmd$);

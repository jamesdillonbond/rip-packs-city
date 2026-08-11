-- golazos_offers cursor_stalled is a FALSE-POSITIVE HIGH alert.
-- golazos-offers-indexer (app/api/golazos-offers-indexer/route.ts) is a STAGED-INERT
-- pipeline shipped 2026-07-28 as a mirror of the live allday-offers-indexer for test
-- coverage/parity. It has NO scheduler (not in vercel.json, no GHA workflow, absent from
-- docs/operations/cron-schedule.md). A single one-off manual tick at 2026-07-28 01:01:34Z
-- (during the interactive session) seeded the event_cursor row 'golazos_offers'
-- (last_processed_block 159452130, 0 rows found, ok=true) and it has not run since.
-- get_pipeline_alerts()'s cursor_stalled arm fires HIGH for ANY event_cursor row older
-- than 6h, so this crossed the threshold at ~07:01Z and now pages via /api/check-alerts
-- (Telegram+email) with no live-production meaning (no surface consumes Golazos offers;
-- live offer cursors topshot_offers/allday_offers are fresh). Mirrors the golazos_listings
-- suppression pattern (bounded, decision-pending). REMOVE this row when golazos-offers-indexer
-- is scheduled (its fresh cursor will make the suppression harmless anyway); if still inert
-- at expiry it re-fires for re-evaluation.
INSERT INTO public.pipeline_alert_suppression (pipeline, reason, added_at, expires_at)
VALUES (
  'golazos_offers',
  'Staged-INERT golazos-offers-indexer (mirror of live allday-offers-indexer, shipped 2026-07-28 for parity/coverage). No scheduler (not in vercel.json/GHA/cron-schedule.md); cursor seeded by a one-off manual tick 2026-07-28 01:01:34Z and never re-run -> permanent cursor_stalled HIGH false-positive. Bounded 30d, decision-pending (schedule the indexer, or delete the cursor row). Remove this row at go-live.',
  now(),
  now() + interval '30 days'
)
ON CONFLICT (pipeline) DO NOTHING;
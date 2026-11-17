-- pack-events-ingest cadence watchlist row.
--
-- The Cloudflare Worker at workers/pack-events-ingest/ runs on a */15
-- cron and writes to event_cursor (topshot_pack_purchases and
-- topshot_pack_opens), pack_purchases, pack_rips, and
-- moment_acquisitions. We register it here so the ops monitor can
-- alert if it stops logging successful runs for >60 minutes.

INSERT INTO pipeline_cadence_watchlist
  (pipeline, max_silent_minutes, severity, notes, is_active)
VALUES (
  'pack-events-ingest',
  60,
  'medium',
  'Pack purchase and pack open event ingest for Top Shot. */15 cron. Two cursors: topshot_pack_purchases and topshot_pack_opens. Other collections AllDay Pinnacle Golazos UFC to follow once Top Shot is proven.',
  true
)
ON CONFLICT (pipeline) DO UPDATE
  SET max_silent_minutes = EXCLUDED.max_silent_minutes,
      severity = EXCLUDED.severity,
      notes = EXCLUDED.notes,
      is_active = EXCLUDED.is_active;

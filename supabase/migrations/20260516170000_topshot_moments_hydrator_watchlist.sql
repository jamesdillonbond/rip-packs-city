-- topshot-moments-hydrator cadence watchlist row.
--
-- The Cloudflare Worker at workers/topshot-moments-hydrator/ reads
-- v_moments_needing_hydration, fetches per-moment metadata from the
-- Top Shot public-api GraphQL via topshot-proxy, resolves edition_id by
-- (set_id_onchain, play_id_onchain) on editions, and upserts into the
-- moments table. Registering it here so ops-monitor can alert if it
-- stops logging successful runs for >60 minutes.

INSERT INTO pipeline_cadence_watchlist
  (pipeline, max_silent_minutes, severity, notes, is_active)
VALUES (
  'topshot-moments-hydrator',
  60,
  'info',
  'Hydrates moments table for pulled Top Shot moments from pack rips. Reads v_moments_needing_hydration, calls TS GraphQL via topshot-proxy, resolves edition_id, upserts moments. Per-invocation budget 300 candidates.',
  true
)
ON CONFLICT (pipeline) DO UPDATE
  SET max_silent_minutes = EXCLUDED.max_silent_minutes,
      severity = EXCLUDED.severity,
      notes = EXCLUDED.notes,
      is_active = EXCLUDED.is_active;

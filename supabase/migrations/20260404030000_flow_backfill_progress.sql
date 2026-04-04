-- Flow blockchain backfill progress tracking table
-- Used by scripts/flow-backfill.ts to resume interrupted runs

CREATE TABLE IF NOT EXISTS flow_backfill_progress (
  id text PRIMARY KEY DEFAULT 'singleton',
  last_processed_height bigint NOT NULL DEFAULT 0,
  total_events_found bigint NOT NULL DEFAULT 0,
  total_inserted bigint NOT NULL DEFAULT 0,
  total_skipped bigint NOT NULL DEFAULT 0,
  started_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

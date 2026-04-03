-- Add collection slug column to players table for collection-aware lookups.
-- Defaults to 'nba_top_shot' so existing rows are backfilled automatically.
-- AllDay ingest sets collection = 'nfl_all_day' on upsert.

ALTER TABLE players
  ADD COLUMN IF NOT EXISTS collection text NOT NULL DEFAULT 'nba_top_shot';

-- Index for filtered jersey number lookups in sniper feeds
CREATE INDEX IF NOT EXISTS idx_players_collection_jersey
  ON players (collection)
  WHERE jersey_number IS NOT NULL;

-- Also add ask_proxy_fmv column to fmv_snapshots for Task 3
ALTER TABLE fmv_snapshots
  ADD COLUMN IF NOT EXISTS ask_proxy_fmv numeric(12, 2) DEFAULT NULL;

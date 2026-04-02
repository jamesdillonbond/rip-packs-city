-- Add collection TEXT column to core tables.
-- Defaults to 'nba_top_shot' so existing rows are unaffected.
-- This is additive only — no columns are dropped or renamed.

ALTER TABLE editions
  ADD COLUMN IF NOT EXISTS collection TEXT NOT NULL DEFAULT 'nba_top_shot';

ALTER TABLE fmv_snapshots
  ADD COLUMN IF NOT EXISTS collection TEXT NOT NULL DEFAULT 'nba_top_shot';

ALTER TABLE sales
  ADD COLUMN IF NOT EXISTS collection TEXT NOT NULL DEFAULT 'nba_top_shot';

ALTER TABLE badge_editions
  ADD COLUMN IF NOT EXISTS collection TEXT NOT NULL DEFAULT 'nba_top_shot';

ALTER TABLE moments
  ADD COLUMN IF NOT EXISTS collection TEXT NOT NULL DEFAULT 'nba_top_shot';

-- Create indexes for filtering by collection on the most-queried tables
CREATE INDEX IF NOT EXISTS idx_editions_collection ON editions (collection);
CREATE INDEX IF NOT EXISTS idx_sales_collection ON sales (collection);
CREATE INDEX IF NOT EXISTS idx_fmv_snapshots_collection ON fmv_snapshots (collection);
CREATE INDEX IF NOT EXISTS idx_moments_collection ON moments (collection);

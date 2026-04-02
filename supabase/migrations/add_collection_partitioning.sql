-- Migration: Add collection TEXT column to core tables
-- Purpose: Support multi-collection partitioning (NBA Top Shot + NFL All Day)
-- This migration is additive only — no data is deleted or modified.

-- 1. editions
ALTER TABLE editions
  ADD COLUMN IF NOT EXISTS collection TEXT NOT NULL DEFAULT 'nba_top_shot';

-- 2. fmv_snapshots
ALTER TABLE fmv_snapshots
  ADD COLUMN IF NOT EXISTS collection TEXT NOT NULL DEFAULT 'nba_top_shot';

-- 3. sales
ALTER TABLE sales
  ADD COLUMN IF NOT EXISTS collection TEXT NOT NULL DEFAULT 'nba_top_shot';

-- 4. badge_editions
ALTER TABLE badge_editions
  ADD COLUMN IF NOT EXISTS collection TEXT NOT NULL DEFAULT 'nba_top_shot';

-- 5. moments
ALTER TABLE moments
  ADD COLUMN IF NOT EXISTS collection TEXT NOT NULL DEFAULT 'nba_top_shot';

-- Add indexes for efficient per-collection queries
CREATE INDEX IF NOT EXISTS idx_editions_collection ON editions (collection);
CREATE INDEX IF NOT EXISTS idx_fmv_snapshots_collection ON fmv_snapshots (collection);
CREATE INDEX IF NOT EXISTS idx_sales_collection ON sales (collection);
CREATE INDEX IF NOT EXISTS idx_badge_editions_collection ON badge_editions (collection);
CREATE INDEX IF NOT EXISTS idx_moments_collection ON moments (collection);

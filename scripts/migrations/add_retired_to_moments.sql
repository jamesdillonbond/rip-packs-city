-- Migration: add_retired_to_moments
-- Adds a retired boolean column to the moments table to track burned/destroyed NFTs.
-- Safe to run multiple times (IF NOT EXISTS).

ALTER TABLE moments ADD COLUMN IF NOT EXISTS retired boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_moments_retired ON moments(retired) WHERE retired = true;

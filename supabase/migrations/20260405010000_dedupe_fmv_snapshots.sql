-- Deduplicate fmv_snapshots: keep only the most recent row per edition_id
-- then add a UNIQUE constraint to prevent future duplicates.

-- Step 1: Delete all rows that are not the latest per edition_id
DELETE FROM fmv_snapshots
WHERE ctid NOT IN (
  SELECT DISTINCT ON (edition_id) ctid
  FROM fmv_snapshots
  ORDER BY edition_id, computed_at DESC
);

-- Step 2: Add unique constraint on edition_id to prevent future duplicates.
-- New inserts for the same edition should use ON CONFLICT DO UPDATE.
ALTER TABLE fmv_snapshots
  ADD CONSTRAINT uq_fmv_snapshots_edition_id UNIQUE (edition_id);

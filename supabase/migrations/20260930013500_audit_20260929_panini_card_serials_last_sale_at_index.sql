-- 2026-09-29 (PT): partial index on panini_card_serials(last_sale_at) for sentinel_panini_health.
-- ops_pgss_delta over the last 24 h ranks sentinel_panini_health() FIRST by physical reads on the
-- instance: 29 calls, 4,436,685 blocks read from disk (~153k per call, ~1.2 GB). It makes two full
-- scans of the 726 MB table (556k rows); `max(last_sale_at)` is one of them — 90,869 disk reads per
-- call, measured — because no index carries last_sale_at.
-- This index serves that max() from ~70k entries (rows with a sale), halving the sentinel's IO.
-- Write side: the Panini ingest (lib/chains/panini/ingest-normalize.ts) re-sends last_sale_at on every
-- walk, but the value only CHANGES when a sale lands, and HOT only breaks when an indexed value
-- changes, so ordinary walk updates keep HOT. The other scan (serials captured in the last 26 h,
-- 351k of 556k rows touched daily) is deliberately left alone: indexing captured_at would take most
-- walk updates off HOT.
-- Plain (non-CONCURRENT) build: one pass over the table, a short write lock.
-- Revert: DROP INDEX public.idx_panini_serials_last_sale_at;
CREATE INDEX IF NOT EXISTS idx_panini_serials_last_sale_at
  ON public.panini_card_serials (last_sale_at)
  WHERE last_sale_at IS NOT NULL;

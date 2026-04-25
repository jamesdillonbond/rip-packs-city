-- Seeds the cursor for pinnacle-owner-discovery-forward at the highest block
-- currently represented in pinnacle_ownership_snapshots. The existing
-- pinnacle-owner-discovery walks BACKWARD from sealed head, so its progress
-- cursor moves down over time and never observes new Deposit events at tip.
-- The forward companion picks up at this seed and walks forward toward the
-- current sealed head, closing the owner-discovery gap.
--
-- ON CONFLICT DO NOTHING because production already has this row populated;
-- this migration exists so a fresh `supabase db reset` reproduces the seed.

INSERT INTO flow_backfill_progress (
    id,
    last_processed_height,
    total_events_found,
    total_inserted,
    total_skipped,
    updated_at
) VALUES (
    'pinnacle-deposit-scan-forward',
    148903911,
    0,
    0,
    0,
    now()
) ON CONFLICT (id) DO NOTHING;

-- Retire the 4 orphan listings cursors from May 12 reseat.
--
-- topshot_listings, golazos_listings, ufc_listings, pack_listings_dapper
-- were all stranded at block 0 on 2026-05-12 14:40-14:41 UTC by the
-- reseat_listing_cursors_after_volume_analysis migration. As of
-- 2026-05-17 the rip-packs-city repo has ZERO references to any of
-- those cursor IDs (grep -r over app/, supabase/, workers/, scripts/),
-- which means the indexer workers that were supposed to drive them
-- post-reseat never shipped (or were removed). pinnacle_listings and
-- allday_listings recovered because their indexers DO exist
-- (pinnacle-listings-indexer, allday-listings-indexer).
--
-- Per the 2026-05-17 audit, the right call is suppression rather than
-- reseat — reseat-without-writer just produces 0-byte runs and noise.
-- 30 days gives time to either ship a writer or delete the event_cursor
-- rows entirely.
INSERT INTO public.pipeline_alert_suppression (pipeline, reason, added_at, expires_at)
VALUES
  ('topshot_listings',     'Cursor stranded at block 0 since 2026-05-12 14:41 UTC reseat. No writer exists in rip-packs-city repo. Indexer retired post volume-analysis. 30d suppression while we decide reseat-with-writer vs delete-cursor.', now(), now() + interval '30 days'),
  ('golazos_listings',     'Cursor stranded at block 0 since 2026-05-12 14:40 UTC reseat. No writer exists in rip-packs-city repo. Indexer retired post volume-analysis. 30d suppression while we decide reseat-with-writer vs delete-cursor.', now(), now() + interval '30 days'),
  ('ufc_listings',         'Cursor stranded at block 0 since 2026-05-12 14:40 UTC reseat. No writer exists in rip-packs-city repo. Indexer retired post volume-analysis. 30d suppression while we decide reseat-with-writer vs delete-cursor.', now(), now() + interval '30 days'),
  ('pack_listings_dapper', 'Cursor stranded at block 0 since 2026-05-12 14:41 UTC reseat. No writer exists in rip-packs-city repo. Indexer retired post volume-analysis. 30d suppression while we decide reseat-with-writer vs delete-cursor.', now(), now() + interval '30 days')
ON CONFLICT DO NOTHING;

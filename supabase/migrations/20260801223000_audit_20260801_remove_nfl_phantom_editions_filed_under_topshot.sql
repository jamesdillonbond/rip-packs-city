-- audit_20260801_remove_nfl_phantom_editions_filed_under_topshot
--
-- WHY
-- Two NFL All Day editions were filed under the Top Shot collection_id and were
-- publicly reachable at /nba-top-shot/edition/{2815,4845}:
--   * 4845 "Bijan Robinson — Base"            (NFL RB, Falcons)
--   * 2815 "Warrick Dunn — Buccaneers Vintage" (NFL RB, Buccaneers)
-- Both are enumerated into the Top Shot sitemap (per-edition pages), so they were
-- index-eligible under the wrong sport.
--
-- ⚠ THESE ARE DUPLICATE STUBS, NOT MISFILED ORIGINALS. The 2026-08-01 handoff
-- proposed reassigning collection_id to AllDay -- that would have FAILED: AllDay
-- already holds both external_ids, and editions carries UNIQUE(external_id,
-- collection_id). The canonical AllDay rows (created 2026-04-12, updated
-- 2026-07-11) carry circulation_count + thumbnail_url; these Top Shot copies
-- (created 2026-04-13, untouched since 2026-04-17) have NULL circulation, no
-- thumbnail, no player_id and no on-chain ids -- classic stub rows written a day
-- later by a writer that resolved the wrong collection.
--   4845 canonical AllDay id = 0f871eb9-9155-420c-b494-cdcce95c7a27
--   2815 canonical AllDay id = 4c06aba2-705b-429a-9f69-89087483321f
-- So the correct action is removal, not reassignment.
--
-- The stubs also dragged in TWO phantom `sets` rows (auto_-prefixed external_ids,
-- one edition each -- the stub itself), which were likewise reachable as Top Shot
-- set pages. No real Top Shot set shares those names, and `sets` has exactly one
-- dependent (editions.set_id), so removing them orphans nothing.
--
-- DEPENDENT SWEEP (all 51 FKs to editions.id checked; only two had rows):
--   * fmv_snapshots        24 rows -- FMV computed for NFL editions inside the Top
--                                     Shot collection, i.e. polluting TS aggregates.
--                                     Regenerable by design; not circuit-breaker guarded.
--   * cached_listings_v2    1 row  -- a CANCELLED 2026-05-10 Flowty listing that already
--                                     carries the correct AllDay collection_id but points
--                                     at the stub edition. Re-pointed to the canonical
--                                     AllDay edition rather than deleted, so the listing
--                                     history survives.
--   * sales / moments / wmc / badge_editions / pack_drop_pool / offers / wishlists /
--     watchlist / special serials / atlas map / all others: ZERO rows.
--
-- The destructive-op circuit breaker (rpc_guard_block_destructive) blocks deletes
-- of >25 `editions` rows; this deletes 2, so it passes untouched -- no opt-in needed.
--
-- REVERT: full pre-state of both editions rows is reproduced in the INSERT at the
-- bottom of this comment block; the two sets rows and the listing re-point are
-- likewise reversible. The 24 fmv_snapshots rows are NOT restored (regenerable
-- history for editions that should never have existed under Top Shot).
--
--   UPDATE public.cached_listings_v2 SET edition_id = '49ddcf10-a7cb-4e51-a16d-74fb16b730d0'
--     WHERE listing_resource_id = 109951165414287;
--   INSERT INTO public.sets (id, name, external_id, collection_id) VALUES
--     ('c2cfd157-5b6a-4b6b-96fc-d5ae85fb14a4','Base','auto_095a1b43effec73955e31e790438de49','95f28a17-224a-4025-96ad-adf8a4c63bfd'),
--     ('eb7fdbfb-2219-4741-ade8-5ec002353b5b','Buccaneers Vintage','auto_9ab1cfeb72ff9c40fa2ef295048b07e1','95f28a17-224a-4025-96ad-adf8a4c63bfd');
--   INSERT INTO public.editions (id, name, tier, badges, series, set_id, set_name, collection,
--     created_at, updated_at, external_id, player_name, edition_kind, collection_id, reward_indicators) VALUES
--     ('49ddcf10-a7cb-4e51-a16d-74fb16b730d0','Warrick Dunn — Buccaneers Vintage','COMMON','{}',6,
--      'eb7fdbfb-2219-4741-ade8-5ec002353b5b','Buccaneers Vintage','nba_top_shot',
--      '2026-04-13T01:41:10.935686+00','2026-04-17T04:08:55.043399+00','2815','Warrick Dunn','LE',
--      '95f28a17-224a-4025-96ad-adf8a4c63bfd','{}'),
--     ('b4ab3b38-8d7b-4465-bd88-4a89219b2abb','Bijan Robinson — Base','COMMON','{}',9,
--      'c2cfd157-5b6a-4b6b-96fc-d5ae85fb14a4','Base','nba_top_shot',
--      '2026-04-13T01:41:10.935686+00','2026-04-17T04:08:55.043399+00','4845','Bijan Robinson','LE',
--      '95f28a17-224a-4025-96ad-adf8a4c63bfd','{}');

-- 1. Preserve the cancelled listing by re-pointing it at the canonical AllDay edition.
UPDATE public.cached_listings_v2
   SET edition_id = '4c06aba2-705b-429a-9f69-89087483321f'
 WHERE edition_id = '49ddcf10-a7cb-4e51-a16d-74fb16b730d0';

-- 2. Drop FMV history computed against the phantom Top Shot rows.
DELETE FROM public.fmv_snapshots
 WHERE edition_id IN ('b4ab3b38-8d7b-4465-bd88-4a89219b2abb',
                      '49ddcf10-a7cb-4e51-a16d-74fb16b730d0');

-- 3. Remove the phantom editions (2 rows -- under the circuit-breaker threshold).
DELETE FROM public.editions
 WHERE id IN ('b4ab3b38-8d7b-4465-bd88-4a89219b2abb',
              '49ddcf10-a7cb-4e51-a16d-74fb16b730d0');

-- 4. Remove the two phantom sets they created (now zero-edition).
DELETE FROM public.sets
 WHERE id IN ('c2cfd157-5b6a-4b6b-96fc-d5ae85fb14a4',
              'eb7fdbfb-2219-4741-ade8-5ec002353b5b')
   AND NOT EXISTS (SELECT 1 FROM public.editions e WHERE e.set_id = sets.id);

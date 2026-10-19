-- PARKED 2026-10-18 ~6:25 PM PT (Claude Code cloud). A data INSERT; data writes from a cloud session
-- are held for operator confirmation, so run it in the SQL editor (or apply_migration and commit it as
-- supabase/migrations/<version>_audit_20261018_topshot_missing_fill_offers_snapshot_refresh.sql).
--
-- WHY (#189): the 10-11 snapshot `topshot_offer_fill_missing_offers` is frozen, but Top Shot offer fills
-- WITHOUT an `offers` row keep arriving: 232 of 2,462 fills since 10-11 15:00 UTC (~9 %/day, every day;
-- re-read 10-18 ~6:15 PM PT). Only 2 of 236 match an Atlas offer event; both had been open ~50 days, i.e. offers
-- created during the pre-10-10 indexer gaps and filled now. Those creations are post-mainnet28, so the
-- recovery walk can reach them once their ids are in the snapshot. Since 2026-10-18 the walk also reads to
-- the sealed tip (it was capped at block 167,400,000).
--
-- This is the 10-11 migration's own INSERT (20261011044422), re-run; ON CONFLICT DO NOTHING keeps the
-- existing 21,372 rows. Expect ~230+ new rows.
INSERT INTO public.topshot_offer_fill_missing_offers (offer_id, fill_tx, sold_at, edition_id, serial_number, buyer_address, price_usd)
SELECT DISTINCT ON (s.offer_id) s.offer_id, s.transaction_hash, s.sold_at, s.edition_id, s.serial_number, s.buyer_address, s.price_usd
FROM public.sales s
WHERE s.source = 'offer_fill'
  AND s.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
  AND s.offer_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM public.offers o WHERE o.offer_id = s.offer_id)
ORDER BY s.offer_id, s.sold_at
ON CONFLICT (offer_id) DO NOTHING;
--
-- THEN: dispatch .github/workflows/topshot-offers-history-backfill.yml with target=missing_fills,
-- start_block=137390146 (re-walk from the mainnet28 root; the cursor already sits at 167.4M), enough
-- max_iters to reach the tip (~150 calls at 200k blocks). Done-check: the 232 drop to the pre-mainnet28
-- remainder, and `extra.inserted` > 0 on the backfill-topshot-missing-fill-offers runs.
-- REVERT: DELETE FROM public.topshot_offer_fill_missing_offers WHERE snapshot_at > '2026-10-18';

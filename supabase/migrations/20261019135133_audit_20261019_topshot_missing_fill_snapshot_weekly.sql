-- audit_20261019_topshot_missing_fill_snapshot_weekly
--
-- 2026-10-19 (Cowork cloud; Trevor: "Keep going. Continue working through everything you can").
-- #189: ~9 % of new Top Shot offer fills (232 of 2,462 over 10-11 → 10-18) arrive with no `offers`
-- row, because the accepted bid was created before the live indexer saw it. The snapshot
-- `topshot_offer_fill_missing_offers` (20261011044422) is what the recovery walk
-- (/api/admin/backfill-topshot-missing-fill-offers) reads, and it only grew when someone re-ran its
-- INSERT by hand. Measured 2026-10-19 ~7:00 AM PT after the 10-18 manual refresh (+247) and re-walk
-- (GitHub run 39203673094, 155 calls, 0 failed): 154 recovered (created 2025-12-30 → 2026-10-11, so
-- the walk cannot be narrowed); 93 remain, pre-spork and out of reach; 12 new unsourced fills had
-- already arrived since the refresh.
--
-- This schedules that same INSERT weekly, Mondays 10:07 UTC; the workflow
-- `topshot-offers-history-backfill.yml` now also runs on schedule (`23 10 * * 1`, target=missing_fills,
-- from block 137390146), 16 minutes later. ON CONFLICT DO NOTHING keeps every existing row, so a
-- re-run only adds the week's new unsourced fills. 27 s when run on 10-18 (job 752, `INSERT 0 247`).
--
-- REVERT: SELECT cron.unschedule('topshot-missing-fill-snapshot-weekly');
--         (rows it added: DELETE FROM public.topshot_offer_fill_missing_offers WHERE snapshot_at > '2026-10-19';)

SELECT cron.schedule('topshot-missing-fill-snapshot-weekly', '7 10 * * 1', $cron$INSERT INTO public.topshot_offer_fill_missing_offers (offer_id, fill_tx, sold_at, edition_id, serial_number, buyer_address, price_usd) SELECT DISTINCT ON (s.offer_id) s.offer_id, s.transaction_hash, s.sold_at, s.edition_id, s.serial_number, s.buyer_address, s.price_usd FROM public.sales s WHERE s.source = 'offer_fill' AND s.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid AND s.offer_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.offers o WHERE o.offer_id = s.offer_id) ORDER BY s.offer_id, s.sold_at ON CONFLICT (offer_id) DO NOTHING$cron$);

DO $$
DECLARE v_n int; v_sched text;
BEGIN
  SELECT count(*), max(schedule) INTO v_n, v_sched FROM cron.job WHERE jobname = 'topshot-missing-fill-snapshot-weekly';
  IF v_n <> 1 OR v_sched <> '7 10 * * 1' THEN
    RAISE EXCEPTION 'topshot-missing-fill-snapshot-weekly not scheduled as expected (n=%, schedule=%)', v_n, v_sched;
  END IF;
END
$$;

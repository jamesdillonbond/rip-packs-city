-- audit_20261114_190_import_dune_marketplace_buys
--
-- WHAT (known-issue #190; Trevor 2026-11-14 9:16 PM PT, after reviewing the stage numbers: "yes keep going"):
--   Copies reviewed rows of public.topshot_dune_acquisition_stage (Dune execution 01M7ES049T43WHA0JD7325ZSWW:
--   pre-2023-11-08 Top Shot marketplace buys whose purchase sits in the same tx as the Deposit TO the wallet)
--   into public.moment_acquisitions:
--   (a) INSERT 37,485 rows for still-held moments (in wallet_moments_cache today) that have NO acquisition row.
--       source 'dune_marketplace_backfill_20261114', method 'marketplace', confidence 'verified'.
--   (b) UPDATE 1,789 'cache_refresh' / 'unknown' rows that had buy_price NULL: price, date, method, seller, tx.
--       Their prior values are archived first in flowty_archive.audit_20261114_190_unpriced_rows.
--   Not imported: 6,846 staged moments absent from wallet_moments_cache (moved or cache stale) and every
--   moment already holding a priced row (2,934 overlaps agreed 2,934/2,934 on price, so nothing to fix).
--
-- REVERT:
--   DELETE FROM public.moment_acquisitions WHERE source = 'dune_marketplace_backfill_20261114';
--   UPDATE public.moment_acquisitions a SET buy_price = b.buy_price, acquired_date = b.acquired_date,
--          acquisition_method = b.acquisition_method, acquisition_confidence = b.acquisition_confidence,
--          seller_address = b.seller_address, transaction_hash = b.transaction_hash, source = b.source
--     FROM flowty_archive.audit_20261114_190_unpriced_rows b WHERE a.id = b.id;

CREATE TABLE IF NOT EXISTS flowty_archive.audit_20261114_190_unpriced_rows AS
SELECT a.*
  FROM public.moment_acquisitions a
  JOIN public.topshot_dune_acquisition_stage s ON s.wallet = a.wallet AND s.nft_id = a.nft_id
 WHERE a.collection_id = (SELECT id FROM public.collections WHERE slug = 'nba_top_shot')
   AND a.buy_price IS NULL
   AND NOT EXISTS (SELECT 1 FROM public.moment_acquisitions o
                    WHERE o.nft_id = a.nft_id AND o.wallet = a.wallet AND o.transaction_hash = s.tx_hash AND o.id <> a.id);

DO $$
DECLARE
  v_ts uuid := (SELECT id FROM public.collections WHERE slug = 'nba_top_shot');
  v_archived int;
  v_upd int;
  v_ins int;
BEGIN
  SELECT count(*) INTO v_archived FROM flowty_archive.audit_20261114_190_unpriced_rows;

  UPDATE public.moment_acquisitions a
     SET buy_price = s.price_usd,
         acquired_date = s.acquired_at,
         acquisition_method = 'marketplace',
         acquisition_confidence = 'verified',
         seller_address = COALESCE(s.seller, a.seller_address),
         transaction_hash = s.tx_hash,
         source = 'dune_marketplace_backfill_20261114'
    FROM public.topshot_dune_acquisition_stage s, flowty_archive.audit_20261114_190_unpriced_rows b
   WHERE b.id = a.id AND s.wallet = a.wallet AND s.nft_id = a.nft_id AND a.buy_price IS NULL;
  GET DIAGNOSTICS v_upd = ROW_COUNT;

  INSERT INTO public.moment_acquisitions
         (nft_id, wallet, buy_price, acquired_date, acquired_type, seller_address, transaction_hash,
          source, collection_id, acquisition_method, acquisition_confidence)
  SELECT s.nft_id, s.wallet, s.price_usd, s.acquired_at, 1, s.seller, s.tx_hash,
         'dune_marketplace_backfill_20261114', v_ts, 'marketplace', 'verified'
    FROM public.topshot_dune_acquisition_stage s
   WHERE EXISTS (SELECT 1 FROM public.wallet_moments_cache w
                  WHERE w.collection_id = v_ts AND w.wallet_address = s.wallet AND w.moment_id = s.nft_id)
     AND NOT EXISTS (SELECT 1 FROM public.moment_acquisitions a
                      WHERE a.collection_id = v_ts AND a.wallet = s.wallet AND a.nft_id = s.nft_id);
  GET DIAGNOSTICS v_ins = ROW_COUNT;

  IF v_upd <> v_archived THEN RAISE EXCEPTION 'updated % rows but archived %', v_upd, v_archived; END IF;
  IF v_upd <> 1789 OR v_ins <> 37485 THEN
    RAISE EXCEPTION 'expected 1789 updates / 37485 inserts, got % / %', v_upd, v_ins;
  END IF;
  RAISE NOTICE 'updated %, inserted %', v_upd, v_ins;
END $$;

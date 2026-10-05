-- 2026-10-04 ~6:20 PM PT — 629 chain-verified Flowty Top Shot sales held back as `edition_conflict`: the checkpoint
-- (spork 25/26/28 roots, or the 128 mint walk) names one base edition, public.topshot_moment_subeditions another.
-- Evidence the checkpoint is right and the local row is a conflation: serial <= circulation 629/629 under the
-- checkpoint edition vs 506/629 under the local one; 595/629 are the same player in a different set; every conflict
-- is with topshot_moment_subeditions (rows written 2026-06-20 .. 07-06), none with topshot_chain_moment_reads, and
-- the spork-root checkpoints agree with each other. Inserted with the checkpoint edition (+ '::sub' from tssub of
-- the same spork); dedup on (tx, nft) and the ±10 min same-NFT guard. The local table itself is NOT changed here
-- (it has many readers — filed as a known issue).
-- Revert: DELETE FROM public.sales s USING flowty_archive.audit_20261004_ckpt_over_local_sales a WHERE s.id = a.sales_id;
CREATE TABLE flowty_archive.audit_20261004_ckpt_over_local_sales AS
WITH m AS (
  SELECT c.* FROM flowty_archive.flowty_chain_listing_completed c
   WHERE c.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
     AND c.payment_vault ~ '\.(DapperUtilityCoin|FiatToken|USDCFlow)\.Vault$' AND c.price > 0 AND c.nft_id ~ '^[0-9]{1,18}$'
     AND NOT EXISTS (SELECT 1 FROM public.sales s WHERE s.transaction_hash = c.tx_hash AND s.nft_id = c.nft_id)),
k AS (
  SELECT m.*, x.spork, x.serial ck_serial,
         x.a || ':' || x.b || CASE WHEN COALESCE(sub.a, 0) > 0 THEN '::' || sub.a ELSE '' END AS ck_ext,
         t.base_external_id AS local_base
    FROM m
    JOIN LATERAL (SELECT * FROM public.checkpoint_nft_meta m0 WHERE m0.c = 'ts' AND m0.nft_id = m.nft_id::bigint ORDER BY m0.spork DESC LIMIT 1) x ON true
    LEFT JOIN public.checkpoint_nft_meta sub ON sub.c = 'tssub' AND sub.nft_id = m.nft_id::bigint AND sub.spork = x.spork
    JOIN public.topshot_moment_subeditions t ON t.nft_id = m.nft_id
   WHERE t.base_external_id IS DISTINCT FROM x.a || ':' || x.b),
r AS (
  SELECT k.*, e.id AS edition_id
    FROM k JOIN public.editions e ON e.collection_id = k.collection_id AND e.external_id = k.ck_ext
   WHERE k.ck_serial > 0 AND k.ck_serial <= COALESCE(e.circulation_count, 2147483647)
     AND NOT EXISTS (SELECT 1 FROM public.sales s WHERE s.collection = 'nba_top_shot' AND s.nft_id = k.nft_id
                       AND s.sold_at BETWEEN k.block_ts - interval '10 minutes' AND k.block_ts + interval '10 minutes')),
ins AS (
  INSERT INTO public.sales (moment_id, edition_id, collection_id, serial_number, price_usd, price_native, currency,
                            seller_address, buyer_address, marketplace, transaction_hash, block_height, sold_at,
                            nft_id, collection, source)
  SELECT NULL, r.edition_id, r.collection_id, r.ck_serial, r.price, r.price,
         CASE WHEN r.payment_vault LIKE '%DapperUtilityCoin%' THEN 'DUC' ELSE 'USDC' END,
         r.seller, r.buyer, 'flowty', r.tx_hash, r.block_height, r.block_ts, r.nft_id, 'nba_top_shot', 'flowty_chain_v1'
    FROM r
  ON CONFLICT DO NOTHING
  RETURNING id, transaction_hash, nft_id, edition_id)
SELECT ins.id AS sales_id, ins.transaction_hash, ins.nft_id, ins.edition_id, r.ck_ext, r.local_base, r.spork
  FROM ins JOIN r ON r.tx_hash = ins.transaction_hash AND r.nft_id = ins.nft_id;

-- Same class in the mainnet24 tx lane (flowty_index_sales verified per transaction): 153 conflicts, checkpoint serial
-- fits 153/153 vs local 134/153, same player 153/153; 138 pass the ±10 min guard. Source flowty_chain_tx_v1
-- (block_height NULL, as that lane writes it).
-- Revert: DELETE FROM public.sales s USING flowty_archive.audit_20261004_ckpt_over_local_sales_tx a WHERE s.id = a.sales_id;
CREATE TABLE flowty_archive.audit_20261004_ckpt_over_local_sales_tx AS
WITH m AS (
  SELECT i.* FROM flowty_archive.flowty_index_sales i
   WHERE i.event_type = 'STOREFRONT_PURCHASED' AND i.verify_status = 'chain_sealed' AND i.verify_detail->>'method' = 'tx'
     AND i.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
     AND i.payment_vault ~ '\.(DapperUtilityCoin|FiatToken|USDCFlow)\.Vault$' AND i.price > 0 AND i.nft_id ~ '^[0-9]{1,18}$'
     AND NOT EXISTS (SELECT 1 FROM public.sales s WHERE s.transaction_hash = i.tx_hash AND s.nft_id = i.nft_id)),
k AS (
  SELECT m.*, x.spork, x.serial ck_serial,
         x.a || ':' || x.b || CASE WHEN COALESCE(sub.a, 0) > 0 THEN '::' || sub.a ELSE '' END AS ck_ext, t.base_external_id AS local_base
    FROM m
    JOIN LATERAL (SELECT * FROM public.checkpoint_nft_meta m0 WHERE m0.c = 'ts' AND m0.nft_id = m.nft_id::bigint ORDER BY m0.spork DESC LIMIT 1) x ON true
    LEFT JOIN public.checkpoint_nft_meta sub ON sub.c = 'tssub' AND sub.nft_id = m.nft_id::bigint AND sub.spork = x.spork
    JOIN public.topshot_moment_subeditions t ON t.nft_id = m.nft_id
   WHERE t.base_external_id IS DISTINCT FROM x.a || ':' || x.b),
r AS (
  SELECT k.*, e.id AS edition_id
    FROM k JOIN public.editions e ON e.collection_id = k.collection_id AND e.external_id = k.ck_ext
   WHERE k.ck_serial > 0 AND k.ck_serial <= COALESCE(e.circulation_count, 2147483647)
     AND NOT EXISTS (SELECT 1 FROM public.sales s WHERE s.collection = 'nba_top_shot' AND s.nft_id = k.nft_id
                       AND s.sold_at BETWEEN k.block_ts - interval '10 minutes' AND k.block_ts + interval '10 minutes')),
ins AS (
  INSERT INTO public.sales (moment_id, edition_id, collection_id, serial_number, price_usd, price_native, currency,
                            seller_address, buyer_address, marketplace, transaction_hash, block_height, sold_at,
                            nft_id, collection, source)
  SELECT NULL, r.edition_id, r.collection_id, r.ck_serial, r.price, r.price,
         CASE WHEN r.payment_vault LIKE '%DapperUtilityCoin%' THEN 'DUC' ELSE 'USDC' END,
         r.seller, r.buyer, 'flowty', r.tx_hash, NULL, r.block_ts, r.nft_id, 'nba_top_shot', 'flowty_chain_tx_v1'
    FROM r
  ON CONFLICT DO NOTHING
  RETURNING id, transaction_hash, nft_id, edition_id)
SELECT ins.id AS sales_id, ins.transaction_hash, ins.nft_id, ins.edition_id, r.ck_ext, r.local_base, r.spork
  FROM ins JOIN r ON r.tx_hash = ins.transaction_hash AND r.nft_id = ins.nft_id;

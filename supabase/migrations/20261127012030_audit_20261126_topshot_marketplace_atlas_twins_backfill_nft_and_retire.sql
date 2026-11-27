-- 2026-11-26 (Claude Code cloud, autonomous pass). 2,487 Top Shot sales from 2026-03-23..30 were stored twice: an
-- `atlas` row (nft_id, no tx hash; ingested 2026-09-12) and a `topshot_marketplace` row for the same sale (tx hash,
-- but nft_id NULL). retire_topshot_atlas_sale_twins (pg_cron 716) matches twins on nft_id, so it could never see these.
--
-- FOUND LIVE: /nba-top-shot/edition/90:2954 listed "#8 · $2.00 · @treyfomo ← @Hotspur · 8 months ago" twice (and #166).
-- MEASURED: every NFT-less topshot_marketplace row is in March 2026 (15,951); 2,487 of them pair with an atlas row on
-- the same edition + serial + price + seller + buyer within 5 min (all < 1 s apart in the samples). The pairing is
-- exactly 1:1 (2,487 pairs, 2,487 distinct atlas rows, 2,487 distinct on-chain rows), no atlas row lacks nft_id, and
-- 0 of the backfilled (tx, nft) pairs collide with an existing row (sales_2026_tx_nft_* unique indexes). $32,982 of
-- Top Shot sale volume was double-counted.
--
-- FIX, through the vetted path: (1) archive each on-chain row's before-state; (2) give it the nft_id its atlas twin
-- carries (adds a fact the row was missing; tx hash, price, parties already agree); (3) one sweep of the existing
-- retire_topshot_atlas_sale_twins over 260 days, which now matches them on its original ±10 min price rule, repoints
-- references, and deletes + archives each atlas twin whole into flowty_archive.audit_topshot_atlas_sale_twins.
--
-- REVERT: rows — INSERT INTO public.sales SELECT (jsonb_populate_record(NULL::public.sales, a.row)).*
--   FROM flowty_archive.audit_topshot_atlas_sale_twins a WHERE a.retired_at >= '2026-11-27 01:00+00';
-- nft_id — UPDATE public.sales s SET nft_id = NULL FROM flowty_archive.audit_20261126_topshot_marketplace_nft_backfill b
--   WHERE s.id = b.sale_id AND s.sold_at = b.sold_at;
CREATE TABLE IF NOT EXISTS flowty_archive.audit_20261126_topshot_marketplace_nft_backfill (
  sale_id uuid NOT NULL,
  sold_at timestamptz NOT NULL,
  atlas_sale_id uuid NOT NULL,
  new_nft_id text NOT NULL,
  written_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (sale_id, sold_at)
);
REVOKE ALL ON flowty_archive.audit_20261126_topshot_marketplace_nft_backfill FROM PUBLIC, anon, authenticated;

WITH p AS (
  SELECT a.id AS atlas_id, a.nft_id, o.id AS sale_id, o.sold_at
    FROM public.sales a
    JOIN public.sales o
      ON o.edition_id = a.edition_id AND o.serial_number = a.serial_number AND o.price_usd = a.price_usd
     AND o.id <> a.id AND o.source = 'topshot_marketplace' AND o.nft_id IS NULL AND o.transaction_hash IS NOT NULL
     AND o.sold_at BETWEEN a.sold_at - interval '5 minutes' AND a.sold_at + interval '5 minutes'
     AND o.seller_address IS NOT DISTINCT FROM a.seller_address AND o.buyer_address IS NOT DISTINCT FROM a.buyer_address
   WHERE a.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd' AND a.source = 'atlas' AND a.transaction_hash IS NULL
     AND a.nft_id IS NOT NULL
     AND a.sold_at >= '2026-03-23' AND a.sold_at < '2026-03-31'
     AND o.sold_at >= '2026-03-22' AND o.sold_at < '2026-04-01'
), uniq AS (
  SELECT p.* FROM p
   WHERE (SELECT count(*) FROM p p2 WHERE p2.atlas_id = p.atlas_id) = 1
     AND (SELECT count(*) FROM p p3 WHERE p3.sale_id = p.sale_id) = 1
)
INSERT INTO flowty_archive.audit_20261126_topshot_marketplace_nft_backfill (sale_id, sold_at, atlas_sale_id, new_nft_id)
SELECT sale_id, sold_at, atlas_id, nft_id FROM uniq
ON CONFLICT DO NOTHING;

UPDATE public.sales s
   SET nft_id = b.new_nft_id
  FROM flowty_archive.audit_20261126_topshot_marketplace_nft_backfill b
 WHERE s.id = b.sale_id AND s.sold_at = b.sold_at
   AND s.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
   AND s.source = 'topshot_marketplace' AND s.nft_id IS NULL;

SELECT public.retire_topshot_atlas_sale_twins(260);

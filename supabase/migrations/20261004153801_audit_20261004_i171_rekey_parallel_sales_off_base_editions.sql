-- 2026-10-04 (PT). #171: Top Shot PARALLEL moments' sales filed under their BASE edition — re-keyed, and the
-- subedition map that let them fold filled from the chain.
--
-- WHAT: 29,814 Top Shot `sales` rows name an NFT that the mainnet checkpoint (public.checkpoint_nft_meta,
-- SubEditionAdmin.momentsSubedition, latest spork per NFT; spork 128 = the MomentMinted / SubeditionAdded
-- event walk) says is a PARALLEL, yet point at the Standard (base `set:play`) edition — a parallel's price
-- feeding the Standard printing's FMV. The parallel edition (`set:play::sub`) exists in `editions` for
-- every one of them. Writers: `onchain` 21,273 (2025-12-29 → today, i.e. STILL happening),
-- `ts_history_backfill_v1` 7,857, and a tail across 9 other sources.
--
-- WHY THEY FOLD: the live writers (app/api/sales-indexer, app/api/cron/topshot-sales-history-backfill) treat
-- a sale as a parallel only when public.topshot_moment_subeditions carries subedition_id > 0 for its NFT.
-- For these NFTs it had no row (68,214 of the 143,991 parallel NFTs the checkpoint knows) or a NULL
-- (1,273), so the sale fell through to the base edition.
--
-- EVIDENCE (measured 2026-10-04 before writing):
--   * the LIVE chain, TopShot.getMomentsSubedition(nftID:) on rest-mainnet at the latest block, for a
--     random 1,000 of these NFTs: 1,000 / 1,000 equal the checkpoint (0 Standard, 0 other parallel);
--   * every NFT where topshot_moment_subeditions already holds a value agrees with the checkpoint:
--     74,504 / 74,504, 0 disagree; topshot_chain_moment_reads 11 / 11 on the overlap.
--
-- WHAT THIS DOES (in this order, one transaction):
--   1. audit_20261004_i171_subeditions_filled — every NFT whose topshot_moment_subeditions row is
--      ABSENT or has subedition_id NULL with the SAME base, and the prior state; then fills it from the
--      checkpoint. A known value is never overridden (none disagree today anyway), and a NULL row whose
--      base_external_id differs from the checkpoint's set:play is left alone.
--   2. audit_20261004_i171_sales_rekey — every Top Shot sale whose NFT the checkpoint says is a parallel
--      and whose edition is that NFT's base, with old and new edition ids; then re-keys `sales.edition_id`.
--      Only the edition changes (serial, price, parties, tx untouched); the UPDATE re-checks that the row
--      still sits on the recorded old edition.
-- FMV for the affected base and parallel editions moves on its next run; that is the point.
--
-- NOT covered: parallel NFTs the checkpoint never read (its wanted set is the NFTs Flowty sold, plus
-- 2026 mints to block 152.5M). Their sales still fold until topshot_moment_subeditions covers them.
--
-- Revert:
--   UPDATE public.sales s SET edition_id = a.old_edition_id FROM public.audit_20261004_i171_sales_rekey a
--    WHERE s.id = a.sale_id AND s.sold_at = a.sold_at AND s.edition_id = a.new_edition_id;
--   DELETE FROM public.topshot_moment_subeditions m USING public.audit_20261004_i171_subeditions_filled a
--    WHERE m.nft_id = a.nft_id AND NOT a.prior_exists;
--   UPDATE public.topshot_moment_subeditions m SET subedition_id = NULL, resolved_at = a.prior_resolved_at
--     FROM public.audit_20261004_i171_subeditions_filled a WHERE m.nft_id = a.nft_id AND a.prior_exists;

CREATE TABLE public.audit_20261004_i171_subeditions_filled (
  nft_id            text PRIMARY KEY,
  base_external_id  text NOT NULL,
  subedition_id     integer NOT NULL,
  checkpoint_spork  smallint NOT NULL,
  prior_exists      boolean NOT NULL,
  prior_resolved_at timestamptz,
  filled_at         timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.audit_20261004_i171_subeditions_filled ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_20261004_i171_subeditions_filled FROM PUBLIC, anon, authenticated;

CREATE TABLE public.audit_20261004_i171_sales_rekey (
  sale_id        uuid NOT NULL,
  sold_at        timestamptz NOT NULL,
  nft_id         text NOT NULL,
  source         text,
  old_edition_id uuid NOT NULL,
  new_edition_id uuid NOT NULL,
  new_external_id text NOT NULL,
  rekeyed_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (sale_id, sold_at)
);
ALTER TABLE public.audit_20261004_i171_sales_rekey ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_20261004_i171_sales_rekey FROM PUBLIC, anon, authenticated;

-- The checkpoint's parallel NFTs: latest spork with a Top Shot record, subedition read at that same spork.
CREATE TEMP TABLE _i171_truth ON COMMIT DROP AS
SELECT m.nft_id, m.spork, m.a AS set_id, m.b AS play_id, sub.a AS sub_id
  FROM (SELECT DISTINCT ON (nft_id) nft_id, spork, a, b
          FROM public.checkpoint_nft_meta WHERE c = 'ts'
         ORDER BY nft_id, spork DESC) m
  JOIN public.checkpoint_nft_meta sub ON sub.c = 'tssub' AND sub.nft_id = m.nft_id AND sub.spork = m.spork AND sub.a > 0;
CREATE INDEX ON _i171_truth (nft_id);

-- 1. subedition map
INSERT INTO public.audit_20261004_i171_subeditions_filled
       (nft_id, base_external_id, subedition_id, checkpoint_spork, prior_exists, prior_resolved_at)
SELECT t.nft_id::text, t.set_id || ':' || t.play_id, t.sub_id, t.spork, (x.nft_id IS NOT NULL), x.resolved_at
  FROM _i171_truth t
  LEFT JOIN public.topshot_moment_subeditions x ON x.nft_id = t.nft_id::text
 WHERE x.nft_id IS NULL
    OR (x.subedition_id IS NULL AND x.base_external_id = t.set_id || ':' || t.play_id);

INSERT INTO public.topshot_moment_subeditions (nft_id, base_external_id, subedition_id, resolved_at)
SELECT a.nft_id, a.base_external_id, a.subedition_id, now()
  FROM public.audit_20261004_i171_subeditions_filled a
ON CONFLICT (nft_id) DO UPDATE SET subedition_id = EXCLUDED.subedition_id, resolved_at = EXCLUDED.resolved_at
 WHERE topshot_moment_subeditions.subedition_id IS NULL
   AND topshot_moment_subeditions.base_external_id = EXCLUDED.base_external_id;

-- 2. sales
INSERT INTO public.audit_20261004_i171_sales_rekey (sale_id, sold_at, nft_id, source, old_edition_id, new_edition_id, new_external_id)
SELECT s.id, s.sold_at, s.nft_id, s.source, s.edition_id, pe.id, pe.external_id
  FROM _i171_truth t
  JOIN public.sales s ON s.nft_id = t.nft_id::text AND s.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
  JOIN public.editions be ON be.id = s.edition_id AND be.external_id = t.set_id || ':' || t.play_id
  JOIN public.editions pe ON pe.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
                         AND pe.external_id = t.set_id || ':' || t.play_id || '::' || t.sub_id;

UPDATE public.sales s
   SET edition_id = a.new_edition_id
  FROM public.audit_20261004_i171_sales_rekey a
 WHERE s.id = a.sale_id AND s.sold_at = a.sold_at AND s.edition_id = a.old_edition_id;
